/* The SCR-1 sign-in flow and the session lifetime (ST-1). Framework-free: views render its state,
 * and every decision it takes rests on what /api/v1/me answered. */
import { loginUrl, type Api, type Me } from '../api/client'
import { parseSignInFailure, type SignInFailure } from './callback'
import { DAILY_REPORT_PATH, isReader } from './roles'
import { isEntryPath, pageFor, pageTitle } from './routes'

export type Screen =
  | { name: 'checking' }
  | { name: 'signIn'; notice: string | null }
  | { name: 'denied'; message: string }
  | { name: 'failed'; failure: SignInFailure }
  | { name: 'unavailable'; traceId: string | null }
  | { name: 'app'; me: Me; path: string }

export interface Announcement {
  politeness: 'polite' | 'assertive'
  text: string
  id: number
}

export interface ViewState {
  screen: Screen
  idleWarning: boolean
  signOutFailed: boolean
  title: string
  announcement: Announcement | null
  focus: string | null
  focusRequest: number
}

export interface Clock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface Navigator {
  path(): string
  search(): string
  push(path: string): void
  replace(path: string): void
  assign(url: string): void
}

export interface Deps {
  api: Api
  clock: Clock
  navigator: Navigator
}

export const FOCUS = {
  signInButton: 'sign-in-button',
  pageHeading: 'page-heading',
  deniedHeading: 'no-access-heading',
  failedHeading: 'sign-in-failed-heading',
  unavailableHeading: 'unavailable-heading',
  staySignedIn: 'stay-signed-in',
} as const

export const TEXT = {
  checking: 'Signing you in',
  failed: "Sign-in didn't complete",
  unavailable: "Can't check your access right now",
  idleWarning: "You'll be signed out in 2 minutes because you haven't used the dashboard.",
  sessionEnded: 'Your session ended. Sign in again to continue.',
  signedOut: "You're signed out.",
  signOutFailed: "Sign-out didn't complete. Try again.",
} as const

/* AC-9: the dialog shows at least 2 minutes before the idle limit. */
export const IDLE_WARNING_LEAD_MS = 2 * 60 * 1000

export class SessionController {
  private state: ViewState = {
    screen: { name: 'checking' },
    idleWarning: false,
    signOutFailed: false,
    title: pageTitle('Signing you in'),
    announcement: null,
    focus: null,
    focusRequest: 0,
  }
  private readonly listeners = new Set<() => void>()
  private timers: unknown[] = []
  private announcements = 0
  /* Answers that arrive after a newer request or a sign-out are ignored. */
  private generation = 0
  private returnTo: string | undefined

  constructor(private readonly deps: Deps) {}

  getState = (): ViewState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /* Opening any dashboard address, including the return from Microsoft (AC-4). */
  start = async (): Promise<void> => {
    const { navigator } = this.deps
    const path = navigator.path()
    const failure = parseSignInFailure(navigator.search())
    if (failure !== null) {
      this.update(
        { screen: { name: 'failed', failure }, idleWarning: false, title: pageTitle(TEXT.failed) },
        FOCUS.failedHeading,
        { politeness: 'assertive', text: TEXT.failed },
      )
      return
    }
    this.returnTo = isEntryPath(path) ? undefined : path
    this.update({ screen: { name: 'checking' }, idleWarning: false, title: pageTitle('Signing you in') }, null, {
      politeness: 'polite',
      text: TEXT.checking,
    })
    await this.checkAccess(path)
  }

  signIn = (): void => {
    this.deps.navigator.assign(loginUrl(this.returnTo))
  }

  /* Moving between dashboard pages; each move asks the server whether the session still stands. */
  navigate = async (path: string): Promise<void> => {
    const { screen } = this.state
    if (screen.name !== 'app') return
    this.deps.navigator.push(path)
    this.showPage(screen.me, path)
    await this.checkAccess(path)
  }

  /* Browser back and forward. */
  syncFromLocation = async (): Promise<void> => {
    const { screen } = this.state
    if (screen.name !== 'app') return
    const path = this.deps.navigator.path()
    this.showPage(screen.me, path)
    await this.checkAccess(path)
  }

  staySignedIn = async (): Promise<void> => {
    const { screen } = this.state
    if (screen.name !== 'app') return
    await this.checkAccess(screen.path)
  }

  signOut = async (): Promise<void> => {
    this.generation += 1
    const signedOut = await this.deps.api.signOut()
    if (!signedOut) {
      this.update({ signOutFailed: true }, null, { politeness: 'assertive', text: TEXT.signOutFailed })
      return
    }
    this.clearTimers()
    this.returnTo = undefined
    this.deps.navigator.replace('/')
    this.showSignIn(TEXT.signedOut)
  }

  /* AC-5: end the denied session first, then start Microsoft sign-in again. */
  signInWithDifferentAccount = async (): Promise<void> => {
    this.generation += 1
    if (await this.deps.api.signOut()) {
      this.deps.navigator.assign(loginUrl())
      return
    }
    this.update({ signOutFailed: true }, null, { politeness: 'assertive', text: TEXT.signOutFailed })
  }

  /* A page's own controller moves focus and speaks through the one pair of live regions. */
  notify = (focus: string | null, announcement: Omit<Announcement, 'id'> | null): void => {
    this.update({}, focus, announcement)
  }

  dispose = (): void => {
    this.generation += 1
    this.clearTimers()
    this.listeners.clear()
  }

  private async checkAccess(path: string): Promise<void> {
    const generation = ++this.generation
    const result = await this.deps.api.getMe()
    if (generation !== this.generation) return
    switch (result.kind) {
      case 'ok':
        this.signedIn(result.me, path)
        return
      case 'unauthenticated':
        this.clearTimers()
        this.showSignIn(this.state.screen.name === 'app' ? TEXT.sessionEnded : null)
        return
      case 'denied':
        /* AC-5: the server named the account in the title and returned no report data. */
        this.clearTimers()
        this.update(
          {
            screen: { name: 'denied', message: result.problem.title },
            idleWarning: false,
            title: pageTitle('No access'),
          },
          FOCUS.deniedHeading,
          { politeness: 'assertive', text: result.problem.title },
        )
        return
      case 'failed':
        this.clearTimers()
        this.update(
          {
            screen: { name: 'unavailable', traceId: result.traceId },
            idleWarning: false,
            title: pageTitle('Unavailable'),
          },
          FOCUS.unavailableHeading,
          { politeness: 'assertive', text: TEXT.unavailable },
        )
    }
  }

  private signedIn(me: Me, path: string): void {
    const { screen, idleWarning } = this.state
    const target = isEntryPath(path) ? DAILY_REPORT_PATH : path
    if (target !== path) this.deps.navigator.replace(target)
    if (screen.name === 'app' && screen.path === target && !idleWarning) {
      this.update({ screen: { name: 'app', me, path: target } }, null, null)
    } else {
      this.showPage(me, target)
    }
    this.schedule(me)
  }

  private showPage(me: Me, path: string): void {
    const page = pageFor(path)
    const allowed = !page.requiresReader || isReader(me.roles)
    this.update(
      {
        screen: { name: 'app', me, path },
        idleWarning: false,
        title: pageTitle(allowed ? page.heading : "This page isn't available"),
      },
      FOCUS.pageHeading,
      null,
    )
  }

  private showSignIn(notice: string | null): void {
    this.update(
      { screen: { name: 'signIn', notice }, idleWarning: false, signOutFailed: false, title: pageTitle('Sign in') },
      FOCUS.signInButton,
      notice === null ? null : { politeness: 'polite', text: notice },
    )
  }

  private schedule(me: Me): void {
    this.clearTimers()
    const now = this.deps.clock.now()
    const idleEnds = Date.parse(me.idleExpiresAt)
    const ends = Math.min(idleEnds, Date.parse(me.absoluteExpiresAt))
    const warnAt = idleEnds - IDLE_WARNING_LEAD_MS
    if (warnAt < ends) {
      this.timers.push(this.deps.clock.setTimeout(this.warnIdle, Math.max(0, warnAt - now)))
    }
    this.timers.push(this.deps.clock.setTimeout(this.expire, Math.max(0, ends - now)))
  }

  private warnIdle = (): void => {
    this.update({ idleWarning: true }, FOCUS.staySignedIn, { politeness: 'assertive', text: TEXT.idleWarning })
  }

  /* The server has ended the session by now: return to the Sign in screen (AC-9). */
  private expire = (): void => {
    this.generation += 1
    this.timers = []
    this.showSignIn(TEXT.sessionEnded)
  }

  private clearTimers(): void {
    for (const handle of this.timers) this.deps.clock.clearTimeout(handle)
    this.timers = []
  }

  private update(patch: Partial<ViewState>, focus: string | null, announcement: Omit<Announcement, 'id'> | null): void {
    this.state = {
      ...this.state,
      ...patch,
      announcement: announcement === null ? this.state.announcement : { ...announcement, id: ++this.announcements },
      focus: focus ?? this.state.focus,
      focusRequest: focus === null ? this.state.focusRequest : this.state.focusRequest + 1,
    }
    for (const listener of this.listeners) listener()
  }
}
