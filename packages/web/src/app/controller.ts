/* The session flow of SCR-1 and the signed-in frame, free of React and the DOM so every
 * transition is tested: which screen shows, the page title, where focus goes, and what is
 * announced (politely or assertively). Every decision comes from /api/v1/me (IF-4).
 * 'Signing you in' is shown and spoken only on the return from Microsoft (AC-4); a plain
 * load waits on the server behind a neutral, silent 'starting' state. */
import { loginHref, type ApiClient, type Me, type MeResult } from '../api/client'
import type { Politeness } from '../a11y/announcer'
import { isReader } from '../auth/roles'
import { sessionTimers } from '../auth/idle'
import { COPY, FOCUS, pageTitle } from '../copy'
import {
  formatUtcTime,
  parseLocation,
  returnPath,
  ROUTE_LABELS,
  ROUTE_PATHS,
  SIGN_IN_PATH,
  type CallbackError,
  type ReportRoute,
} from './routes'

export type Screen =
  | { kind: 'starting' }
  | { kind: 'checking' }
  | { kind: 'sign-in'; notice?: 'signed-out' | 'expired' }
  | { kind: 'sign-in-error'; error: CallbackError }
  | { kind: 'no-access'; title: string }
  | { kind: 'unavailable' }
  | { kind: 'app'; me: Me; route: ReportRoute | 'none'; idleWarning: boolean }

export interface Ports {
  api: ApiClient
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  redirect(url: string): void
  pushUrl(path: string): void
  replaceUrl(path: string): void
  setTitle(title: string): void
  focus(id: string): void
  announce(text: string, politeness: Politeness): void
}

type Location = { pathname: string; search: string }

export class SessionController {
  private screen: Screen = { kind: 'starting' }
  private route: ReportRoute = 'daily'
  private timers: unknown[] = []
  private readonly listeners = new Set<() => void>()

  constructor(private readonly ports: Ports) {}

  getState = (): Screen => this.screen

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(location: Location): Promise<void> {
    const destination = parseLocation(location)
    if (destination.kind !== 'app') return this.show(destination)
    this.route = destination.route
    /* Drop the return marker so a reload or a shared link is a plain load. */
    if (destination.returning) this.ports.replaceUrl(ROUTE_PATHS[this.route])
    await this.check({ showChecking: destination.returning === true, push: false })
  }

  async restore(location: Location): Promise<void> {
    const destination = parseLocation(location)
    if (destination.kind === 'app') {
      this.route = destination.route
      await this.check({ showChecking: false, push: false })
    } else {
      this.clearTimers()
      this.show(destination)
    }
  }

  async navigate(route: ReportRoute): Promise<void> {
    this.route = route
    await this.check({ showChecking: false, push: true })
  }

  async retry(): Promise<void> {
    await this.check({ showChecking: false, push: false })
  }

  signIn(): void {
    this.ports.redirect(loginHref({ returnTo: returnPath(this.route) }))
  }

  async signInWithDifferentAccount(): Promise<void> {
    if ((await this.ports.api.signOut()) === 'failed') return this.signOutFailed()
    this.clearTimers()
    this.ports.redirect(loginHref({ returnTo: returnPath(this.route), maxAge: 0 }))
  }

  /** IF-5: each outcome its own way. A failed sign-out keeps the screen, since the server
   * session may still be live, and says so assertively. */
  async signOut(): Promise<void> {
    const result = await this.ports.api.signOut()
    if (result === 'failed') return this.signOutFailed()
    if (result === 'already-signed-out') return this.expire()
    this.clearTimers()
    this.ports.pushUrl(SIGN_IN_PATH)
    this.show({ kind: 'sign-in', notice: 'signed-out' })
    this.ports.announce(COPY.signIn.signedOut, 'polite')
  }

  async staySignedIn(): Promise<void> {
    const result = await this.ports.api.getMe()
    if (result.kind !== 'signed-in' || this.screen.kind !== 'app') return this.apply(result, false)
    this.enterApp(result.me, this.screen.route)
    this.ports.focus(FOCUS.main)
    this.ports.announce(COPY.idle.stillSignedIn, 'polite')
  }

  dispose(): void {
    this.clearTimers()
  }

  private async check({ showChecking, push }: { showChecking: boolean; push: boolean }): Promise<void> {
    if (showChecking) {
      this.show({ kind: 'checking' })
      this.ports.announce(COPY.signingIn.announcement, 'polite')
    }
    this.apply(await this.ports.api.getMe(), push)
  }

  private apply(result: MeResult, push: boolean): void {
    switch (result.kind) {
      case 'signed-in': {
        const route = isReader(result.me.roles) ? this.route : 'none'
        if (push && route !== 'none') this.ports.pushUrl(ROUTE_PATHS[route])
        this.enterApp(result.me, route)
        this.ports.setTitle(pageTitle(route === 'none' ? undefined : ROUTE_LABELS[route]))
        this.ports.focus(FOCUS.main)
        return
      }
      case 'signed-out':
        if (this.screen.kind === 'app') return this.expire()
        return this.show({ kind: 'sign-in' })
      case 'no-access':
        this.clearTimers()
        this.show({ kind: 'no-access', title: result.title })
        return this.ports.announce(result.title, 'assertive')
      case 'unavailable':
        this.clearTimers()
        this.show({ kind: 'unavailable' })
        return this.ports.announce(COPY.unavailable.heading, 'assertive')
    }
  }

  private enterApp(me: Me, route: ReportRoute | 'none'): void {
    this.clearTimers()
    this.setScreen({ kind: 'app', me, route, idleWarning: false })
    const { warnInMs, endInMs } = sessionTimers(me, this.ports.now())
    if (warnInMs !== null) this.timers.push(this.ports.setTimer(() => this.warn(), warnInMs))
    this.timers.push(this.ports.setTimer(() => this.expire(), endInMs))
  }

  private warn(): void {
    if (this.screen.kind !== 'app') return
    this.setScreen({ ...this.screen, idleWarning: true })
    this.ports.focus(FOCUS.staySignedIn)
    this.ports.announce(
      `${COPY.idle.title}. ${COPY.idle.body(formatUtcTime(this.screen.me.idleExpiresAt))}`,
      'assertive',
    )
  }

  private signOutFailed(): void {
    this.ports.announce(COPY.signOut.failed, 'assertive')
  }

  private expire(): void {
    this.clearTimers()
    this.ports.pushUrl(SIGN_IN_PATH)
    this.show({ kind: 'sign-in', notice: 'expired' })
    this.ports.announce(COPY.signIn.expired, 'polite')
  }

  /** Shows a screen other than the signed-in frame: its title, its focus, and for errors its alert. */
  private show(screen: Exclude<Screen, { kind: 'app' | 'starting' }>): void {
    this.setScreen(screen)
    switch (screen.kind) {
      case 'checking':
        this.ports.setTitle(pageTitle(COPY.signingIn.title))
        return this.ports.focus(FOCUS.signingIn)
      case 'sign-in':
        this.ports.setTitle(pageTitle(COPY.signIn.title))
        return this.ports.focus(FOCUS.signInButton)
      case 'sign-in-error':
        this.ports.setTitle(pageTitle(COPY.signInError.title))
        this.ports.focus(FOCUS.signInError)
        return this.ports.announce(COPY.signInError.heading, 'assertive')
      case 'no-access':
        this.ports.setTitle(pageTitle(COPY.noAccess.title))
        return this.ports.focus(FOCUS.noAccess)
      case 'unavailable':
        this.ports.setTitle(pageTitle(COPY.unavailable.title))
        return this.ports.focus(FOCUS.unavailable)
    }
  }

  private setScreen(screen: Screen): void {
    this.screen = screen
    this.listeners.forEach((listener) => listener())
  }

  private clearTimers(): void {
    this.timers.forEach((handle) => this.ports.clearTimer(handle))
    this.timers = []
  }
}
