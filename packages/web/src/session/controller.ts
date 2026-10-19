/* SCR-1 session flow for ST-1: what the dashboard shows from returning from Microsoft to
 * signing out. Every decision comes from the BFF (IF-4 status, roles and expiry times);
 * the controller only reflects it, moves focus and queues announcements. */
import { loginUrl, type ApiClient, type Me, type MeResult } from '../api/client'
import { copy, pageTitle, APP_NAME } from '../copy'
import { DAILY_REPORT_PATH } from './roles'

export const SIGNING_IN_PATH = '/signing-in'
export const SIGN_IN_ERROR_PATH = '/signin-error'
/* AC-9: the warning opens at least 2 minutes before the BFF's idle limit. */
export const IDLE_WARNING_LEAD_MS = 2 * 60 * 1000

export type View =
  | { kind: 'loading' }
  | { kind: 'signIn'; notice: 'signedOut' | 'expired' | null }
  | { kind: 'checking' }
  | { kind: 'signInFailed'; code: string; reference: string | null; timestamp: string }
  | { kind: 'noAccess'; message: string }
  | { kind: 'unavailable' }
  | { kind: 'dashboard'; me: Me; page: 'daily' | 'home'; idleWarning: boolean }

export interface Announcement {
  id: number
  text: string
  politeness: 'polite' | 'assertive'
}

export interface SessionState {
  view: View
  announcement: Announcement | null
}

export type FocusTarget = 'page-heading' | 'signin-button' | 'stay-signed-in' | 'restore'

export interface Ports {
  api: ApiClient
  location: { pathname: string; search: string }
  replaceUrl(path: string): void
  assign(url: string): void
  setTitle(title: string): void
  focus(target: FocusTarget): void
  schedule(ms: number, task: () => void): () => void
  now(): number
}

export interface SessionController {
  getState(): SessionState
  subscribe(listener: () => void): () => void
  start(): Promise<void>
  signIn(): void
  signInWithDifferentAccount(): void
  tryAgain(): void
  recheck(): Promise<void>
  staySignedIn(): Promise<void>
  signOut(): Promise<void>
}

export function createSessionController(ports: Ports): SessionController {
  let state: SessionState = { view: { kind: 'loading' }, announcement: null }
  let announcementId = 0
  let generation = 0
  let timers: Array<() => void> = []
  const listeners = new Set<() => void>()

  const publish = (view: View, announce?: Omit<Announcement, 'id'>): void => {
    state = { view, announcement: announce ? { ...announce, id: ++announcementId } : state.announcement }
    for (const listener of listeners) listener()
  }

  const cancelTimers = (): void => {
    for (const cancel of timers) cancel()
    timers = []
  }

  const showSignIn = (notice: 'signedOut' | 'expired' | null): void => {
    cancelTimers()
    ports.setTitle(pageTitle(copy.signIn.title))
    if (notice === null) publish({ kind: 'signIn', notice })
    else publish({ kind: 'signIn', notice }, { text: copy.signIn[notice], politeness: 'polite' })
    ports.focus('signin-button')
  }

  const expire = (): void => {
    generation++
    ports.replaceUrl('/')
    showSignIn('expired')
  }

  const openIdleWarning = (): void => {
    if (state.view.kind !== 'dashboard') return
    publish({ ...state.view, idleWarning: true }, { text: copy.idle.announcement, politeness: 'assertive' })
    ports.focus('stay-signed-in')
  }

  const scheduleLimits = (me: Me): void => {
    cancelTimers()
    const now = ports.now()
    const idleAt = Date.parse(me.idleExpiresAt)
    const absoluteAt = Date.parse(me.absoluteExpiresAt)
    const warnAt = idleAt - IDLE_WARNING_LEAD_MS
    if (warnAt < absoluteAt) timers.push(ports.schedule(Math.max(0, warnAt - now), openIdleWarning))
    timers.push(ports.schedule(Math.max(0, Math.min(idleAt, absoluteAt) - now), expire))
  }

  const apply = (result: MeResult, refreshing: boolean): void => {
    switch (result.status) {
      case 'ok': {
        const page = result.me.roles.includes('reader') ? 'daily' : 'home'
        const wasWarning = state.view.kind === 'dashboard' && state.view.idleWarning
        if (!refreshing) {
          const path = page === 'daily' ? DAILY_REPORT_PATH : '/'
          if (ports.location.pathname !== path) ports.replaceUrl(path)
          ports.setTitle(page === 'daily' ? pageTitle(copy.shell.dailyReport) : APP_NAME)
        }
        publish({ kind: 'dashboard', me: result.me, page, idleWarning: false })
        scheduleLimits(result.me)
        ports.focus(refreshing && wasWarning ? 'restore' : 'page-heading')
        return
      }
      case 'unauthenticated':
        if (refreshing) expire()
        else showSignIn(null)
        return
      case 'forbidden': {
        cancelTimers()
        const message = result.problem?.title ?? copy.noAccess.fallback
        ports.setTitle(pageTitle(copy.noAccess.title))
        publish({ kind: 'noAccess', message }, { text: message, politeness: 'assertive' })
        ports.focus('page-heading')
        return
      }
      case 'unavailable':
        cancelTimers()
        ports.setTitle(pageTitle(copy.unavailable.title))
        publish({ kind: 'unavailable' }, { text: copy.unavailable.heading, politeness: 'assertive' })
        ports.focus('page-heading')
    }
  }

  const check = async (refreshing: boolean): Promise<void> => {
    const current = ++generation
    const result = await ports.api.getMe()
    if (current === generation) apply(result, refreshing)
  }

  const showFailure = (code: string, query: URLSearchParams): void => {
    const at = query.get('at')
    const parsed = at === null ? NaN : Date.parse(at)
    const timestamp = new Date(Number.isNaN(parsed) ? ports.now() : parsed).toISOString()
    ports.setTitle(pageTitle(copy.failed.title))
    publish(
      { kind: 'signInFailed', code, reference: query.get('ref'), timestamp },
      { text: copy.failed.heading, politeness: 'assertive' },
    )
    ports.focus('page-heading')
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async start() {
      const query = new URLSearchParams(ports.location.search)
      const code = query.get('error')
      if (ports.location.pathname === SIGN_IN_ERROR_PATH && code !== null) {
        showFailure(code, query)
        return
      }
      if (ports.location.pathname === SIGNING_IN_PATH) {
        ports.setTitle(pageTitle(copy.checking.title))
        publish({ kind: 'checking' }, { text: copy.checking.announcement, politeness: 'polite' })
      }
      await check(false)
    },
    signIn() {
      ports.assign(loginUrl({ returnTo: SIGNING_IN_PATH }))
    },
    signInWithDifferentAccount() {
      ports.assign(loginUrl({ returnTo: SIGNING_IN_PATH, maxAge: 0 }))
    },
    tryAgain() {
      ports.assign(loginUrl({ returnTo: SIGNING_IN_PATH }))
    },
    async recheck() {
      publish({ kind: 'loading' })
      await check(false)
    },
    async staySignedIn() {
      await check(true)
    },
    async signOut() {
      generation++
      cancelTimers()
      await ports.api.signOut()
      ports.replaceUrl('/')
      showSignIn('signedOut')
    },
  }
}
