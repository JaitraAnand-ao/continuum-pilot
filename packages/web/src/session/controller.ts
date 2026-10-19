import { loginUrl, type Me, type MeResult } from '../api/client'
import { parseSignInFailure, SIGN_IN_ERROR_PATH, type SignInFailure } from './failure'
import { SCREENS, screenFor, type ScreenId } from './roles'
import { msUntilPhaseChange, sessionPhase } from './timing'

/* SCR-1's states and the session lifecycle, free of the DOM so every transition is testable.
 * Every decision is taken from what the BFF answered: the status of /api/v1/me and its limits. */

export type AppState =
  | { kind: 'checking' }
  | { kind: 'signed-out' }
  | { kind: 'denied'; message: string }
  | { kind: 'failed'; failure: SignInFailure }
  | { kind: 'unavailable' }
  | { kind: 'signed-in'; me: Me; screen: ScreenId; warning: boolean }

export interface Api {
  getMe(): Promise<MeResult>
  logout(): Promise<boolean>
}

export interface Navigation {
  pathname(): string
  search(): string
  assign(url: string): void
  replace(path: string): void
}

export interface Clock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface SessionActions {
  signIn(): void
  signOut(): Promise<void>
  signInWithDifferentAccount(): Promise<void>
  staySignedIn(): Promise<void>
  tryAgain(): void
  recheck(): Promise<void>
}

export class SessionController implements SessionActions {
  private state: AppState = { kind: 'checking' }
  private readonly listeners = new Set<() => void>()
  private timer: unknown = undefined
  private returnTo: string | undefined

  constructor(
    private readonly api: Api,
    private readonly nav: Navigation,
    private readonly clock: Clock,
  ) {}

  getState = (): AppState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(): Promise<void> {
    const pathname = this.nav.pathname()
    if (pathname === SIGN_IN_ERROR_PATH) {
      this.set({ kind: 'failed', failure: parseSignInFailure(this.nav.search(), this.clock.now()) })
      return
    }
    if (pathname !== '/') this.returnTo = `${pathname}${this.nav.search()}`
    await this.recheck()
  }

  dispose(): void {
    this.clearTimer()
    this.listeners.clear()
  }

  recheck = async (): Promise<void> => {
    this.set({ kind: 'checking' })
    this.apply(await this.api.getMe())
  }

  signIn = (): void => {
    this.nav.assign(loginUrl(this.returnTo))
  }

  tryAgain = (): void => {
    this.nav.assign(loginUrl())
  }

  signOut = async (): Promise<void> => {
    this.clearTimer()
    await this.api.logout()
    this.endSession()
  }

  signInWithDifferentAccount = async (): Promise<void> => {
    await this.api.logout()
    this.nav.assign(loginUrl())
  }

  staySignedIn = async (): Promise<void> => {
    const result = await this.api.getMe()
    if (result.status === 200 && this.state.kind === 'signed-in') {
      this.set({ ...this.state, me: result.me, warning: false })
      this.schedule()
      return
    }
    this.apply(result)
  }

  private apply(result: MeResult): void {
    this.clearTimer()
    switch (result.status) {
      case 200: {
        const screen = screenFor(this.nav.pathname(), result.me.roles)
        if (this.nav.pathname() !== SCREENS[screen].href) this.nav.replace(SCREENS[screen].href)
        this.set({ kind: 'signed-in', me: result.me, screen, warning: false })
        this.schedule()
        return
      }
      case 401:
        this.set({ kind: 'signed-out' })
        return
      case 403:
        this.set({ kind: 'denied', message: result.problem.title })
        return
      default:
        this.set({ kind: 'unavailable' })
    }
  }

  private schedule(): void {
    this.clearTimer()
    if (this.state.kind !== 'signed-in') return
    const now = this.clock.now()
    const phase = sessionPhase(this.state.me, now)
    if (phase === 'expired') {
      this.endSession()
      return
    }
    if (phase === 'warning' && !this.state.warning) this.set({ ...this.state, warning: true })
    const wait = msUntilPhaseChange(this.state.me, now) ?? 0
    this.timer = this.clock.setTimeout(() => this.schedule(), wait)
  }

  private endSession(): void {
    this.clearTimer()
    this.returnTo = undefined
    this.nav.replace('/')
    this.set({ kind: 'signed-out' })
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = undefined
  }

  private set(state: AppState): void {
    this.state = state
    this.listeners.forEach((listener) => listener())
  }
}
