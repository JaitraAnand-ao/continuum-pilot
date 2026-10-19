import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Api, MeResult } from '../api/client'
import { browserClock } from '../browser'
import { ADMIN_ONLY, MINUTE, NO_ACCESS, NOW, READER, READER_AND_ADMIN, SERVER_ERROR, me } from '../testing/fixtures'
import { FOCUS, IDLE_WARNING_LEAD_MS, SessionController, TEXT, type Navigator } from './controller'

const ok = (body = READER): MeResult => ({ kind: 'ok', me: body })
const unauthenticated: MeResult = { kind: 'unauthenticated' }
const denied: MeResult = { kind: 'denied', problem: NO_ACCESS }

function setup(path = '/', search = '', answers: MeResult[] = [ok()], signOut = [true]) {
  let location = { path, search }
  const navigator = {
    path: () => location.path,
    search: () => location.search,
    push: vi.fn((next: string) => (location = { path: next, search: '' })),
    replace: vi.fn((next: string) => (location = { path: next, search: '' })),
    assign: vi.fn(),
  } satisfies Navigator
  const api = {
    getMe: vi.fn(async () => answers.shift() ?? unauthenticated),
    signOut: vi.fn(async () => signOut.shift() ?? true),
  } satisfies Api
  const controller = new SessionController({ api, navigator, clock: browserClock(globalThis) })
  const listener = vi.fn()
  controller.subscribe(listener)
  return { controller, api, navigator, listener, state: controller.getState }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Feature: Sign in to the dashboard with my Entra ID account, and keep everyone else out', () => {
  describe('Scenario: The sign-in screen explains what it protects (AC-1)', () => {
    it('Given I am not signed in, When I open the dashboard address, Then the Sign in screen takes focus on its button', async () => {
      const { controller, state } = setup('/', '', [unauthenticated])
      await controller.start()
      expect(state().screen).toEqual({ name: 'signIn', notice: null })
      expect(state().focus).toBe(FOCUS.signInButton)
      expect(state().title).toBe('Sign in – Entra Sign-In Reports')
    })

    it('selecting Sign in with Microsoft starts IF-1 sign-in', async () => {
      const { controller, navigator } = setup('/', '', [unauthenticated])
      await controller.start()
      controller.signIn()
      expect(navigator.assign).toHaveBeenCalledWith('/auth/login')
    })

    it('a deep link survives sign-in as the IF-1 returnTo', async () => {
      const { controller, navigator } = setup('/reports/history', '', [unauthenticated])
      await controller.start()
      controller.signIn()
      expect(navigator.assign).toHaveBeenCalledWith('/auth/login?returnTo=%2Freports%2Fhistory')
    })
  })

  describe('Scenario: A reader lands on the Daily report (AC-2)', () => {
    it('Given a reader, When Microsoft sign-in completes, Then the Daily report shows with focus on its heading', async () => {
      const { controller, state, navigator } = setup('/')
      await controller.start()
      expect(state().screen).toEqual({ name: 'app', me: READER, path: '/reports/daily' })
      expect(navigator.replace).toHaveBeenCalledWith('/reports/daily')
      expect(state().focus).toBe(FOCUS.pageHeading)
      expect(state().title).toBe('Daily report – Entra Sign-In Reports')
    })

    it('a reader returning to a deep link lands on that page', async () => {
      const { controller, state, navigator } = setup('/reports/suspicious')
      await controller.start()
      expect(state().screen).toEqual({ name: 'app', me: READER, path: '/reports/suspicious' })
      expect(navigator.replace).not.toHaveBeenCalled()
      expect(state().title).toBe('Suspicious activity – Entra Sign-In Reports')
    })

    it('moving to another report moves focus to its heading and rechecks the session', async () => {
      const { controller, state, navigator, api } = setup('/', '', [ok(), ok()])
      await controller.start()
      const focusRequest = state().focusRequest
      await controller.navigate('/reports/history')
      expect(navigator.push).toHaveBeenCalledWith('/reports/history')
      expect(state().screen).toMatchObject({ name: 'app', path: '/reports/history' })
      expect(state().title).toBe('Report history – Entra Sign-In Reports')
      expect(state().focusRequest).toBe(focusRequest + 1)
      expect(api.getMe).toHaveBeenCalledTimes(2)
    })

    it('back and forward follow the address bar', async () => {
      const { controller, state, navigator } = setup('/', '', [ok(), ok()])
      await controller.start()
      navigator.push('/reports/suspicious')
      await controller.syncFromLocation()
      expect(state().screen).toMatchObject({ name: 'app', path: '/reports/suspicious' })
      expect(state().focus).toBe(FOCUS.pageHeading)
    })

    it('navigation does nothing before sign-in', async () => {
      const { controller, api, navigator } = setup('/', '', [unauthenticated])
      await controller.start()
      await controller.navigate('/reports/daily')
      await controller.syncFromLocation()
      await controller.staySignedIn()
      expect(navigator.push).not.toHaveBeenCalled()
      expect(api.getMe).toHaveBeenCalledTimes(1)
    })
  })

  describe('Scenario: A reader who is also a report administrator lands on the Daily report (AC-3)', () => {
    it('Given both app roles, When sign-in completes, Then the Daily report shows', async () => {
      const { controller, state } = setup('/', '', [ok(READER_AND_ADMIN)])
      await controller.start()
      expect(state().screen).toEqual({ name: 'app', me: READER_AND_ADMIN, path: '/reports/daily' })
    })

    it('an administrator without the reader role is not shown a report page', async () => {
      const { controller, state } = setup('/', '', [ok(ADMIN_ONLY)])
      await controller.start()
      expect(state().title).toBe("This page isn't available – Entra Sign-In Reports")
    })
  })

  describe('Scenario: Access is checked after returning from Microsoft (AC-4)', () => {
    it('Given Microsoft sign-in completed, When access is being checked, Then Signing you in shows and is announced politely', () => {
      const { controller, state } = setup('/')
      void controller.start()
      expect(state().screen).toEqual({ name: 'checking' })
      expect(state().announcement).toEqual({ politeness: 'polite', text: 'Signing you in', id: 1 })
      expect(state().title).toBe('Signing you in – Entra Sign-In Reports')
    })
  })

  describe('Scenario: Someone outside both groups is turned away (AC-5)', () => {
    it('Given neither group, When sign-in completes, Then You don’t have access names the account and is announced assertively', async () => {
      const { controller, state } = setup('/', '', [denied])
      await controller.start()
      expect(state().screen).toEqual({ name: 'denied', message: NO_ACCESS.title })
      expect(state().title).toBe('No access – Entra Sign-In Reports')
      expect(state().focus).toBe(FOCUS.deniedHeading)
      expect(state().announcement).toMatchObject({ politeness: 'assertive', text: NO_ACCESS.title })
    })

    it('Sign in with a different account ends the session and starts Microsoft sign-in again', async () => {
      const { controller, api, navigator } = setup('/', '', [denied])
      await controller.start()
      await controller.signInWithDifferentAccount()
      expect(api.signOut).toHaveBeenCalledTimes(1)
      expect(navigator.assign).toHaveBeenCalledWith('/auth/login')
    })

    it('when ending the denied session fails, the account is not switched and the failure is announced', async () => {
      const { controller, state, navigator } = setup('/', '', [denied], [false])
      await controller.start()
      await controller.signInWithDifferentAccount()
      expect(navigator.assign).not.toHaveBeenCalled()
      expect(state().signOutFailed).toBe(true)
      expect(state().announcement).toMatchObject({ politeness: 'assertive', text: TEXT.signOutFailed })
    })

    it('Sign out returns the denied account to the Sign in screen', async () => {
      const { controller, state } = setup('/', '', [denied])
      await controller.start()
      await controller.signOut()
      expect(state().screen).toEqual({ name: 'signIn', notice: TEXT.signedOut })
    })
  })

  describe('Scenario: A denied account cannot reach a report by its address (AC-5)', () => {
    it('Given a denied account, When it opens the Daily report address, Then no report is shown', async () => {
      const { controller, state } = setup('/reports/daily', '', [denied])
      await controller.start()
      expect(state().screen.name).toBe('denied')
    })
  })

  describe('Scenario: Sign-in does not complete at Microsoft (AC-6)', () => {
    it('Given Microsoft returned an error, When the callback is handled, Then the failure shows and is announced', async () => {
      const { controller, state, api } = setup('/sign-in', '?error=AADSTS50105&ref=7f3c2a91&at=2026-10-19T08:00:05Z')
      await controller.start()
      expect(api.getMe).not.toHaveBeenCalled()
      expect(state().screen).toEqual({
        name: 'failed',
        failure: { code: 'AADSTS50105', reference: '7f3c2a91', occurredAt: '2026-10-19 08:00:05 UTC' },
      })
      expect(state().title).toBe("Sign-in didn't complete – Entra Sign-In Reports")
      expect(state().focus).toBe(FOCUS.failedHeading)
      expect(state().announcement).toMatchObject({ politeness: 'assertive', text: "Sign-in didn't complete" })
    })

    it('Try again starts sign-in afresh', async () => {
      const { controller, navigator } = setup('/sign-in', '?error=AADSTS50105')
      await controller.start()
      controller.signIn()
      expect(navigator.assign).toHaveBeenCalledWith('/auth/login')
    })
  })

  describe('/api/v1/me answering outside its contract', () => {
    it('an unavailable server shows its trace id and Try again checks again', async () => {
      const failed: MeResult = { kind: 'failed', status: 503, traceId: SERVER_ERROR.traceId }
      const { controller, state } = setup('/', '', [failed, ok()])
      await controller.start()
      expect(state().screen).toEqual({ name: 'unavailable', traceId: SERVER_ERROR.traceId })
      expect(state().focus).toBe(FOCUS.unavailableHeading)
      expect(state().announcement).toMatchObject({ politeness: 'assertive', text: TEXT.unavailable })
      await controller.start()
      expect(state().screen.name).toBe('app')
    })
  })

  describe('Scenario: An idle session warns before it ends (AC-9)', () => {
    it('Given 13 minutes idle, When the warning appears, Then Stay signed in takes focus and it is announced assertively', async () => {
      const { controller, state } = setup('/')
      await controller.start()
      vi.advanceTimersByTime(13 * MINUTE - 1)
      expect(state().idleWarning).toBe(false)
      vi.advanceTimersByTime(1)
      expect(state().idleWarning).toBe(true)
      expect(state().focus).toBe(FOCUS.staySignedIn)
      expect(state().announcement).toMatchObject({ politeness: 'assertive', text: TEXT.idleWarning })
      expect(IDLE_WARNING_LEAD_MS).toBeGreaterThanOrEqual(2 * MINUTE)
    })

    it('Stay signed in renews the session, closes the dialog and returns focus to the page heading', async () => {
      const renewed = me(['reader'], { idleExpiresAt: new Date(NOW + 28 * MINUTE).toISOString() })
      const { controller, state, api } = setup('/', '', [ok(), ok(renewed)])
      await controller.start()
      vi.advanceTimersByTime(13 * MINUTE)
      await controller.staySignedIn()
      expect(api.getMe).toHaveBeenCalledTimes(2)
      expect(state().idleWarning).toBe(false)
      expect(state().focus).toBe(FOCUS.pageHeading)
      vi.advanceTimersByTime(13 * MINUTE - 1)
      expect(state().idleWarning).toBe(false)
      vi.advanceTimersByTime(1)
      expect(state().idleWarning).toBe(true)
    })

    it('Sign out from the warning ends the session', async () => {
      const { controller, state } = setup('/')
      await controller.start()
      vi.advanceTimersByTime(13 * MINUTE)
      await controller.signOut()
      expect(state().screen.name).toBe('signIn')
      expect(state().idleWarning).toBe(false)
    })
  })

  describe('Scenario: An idle session ends after 15 minutes (AC-9)', () => {
    it('Given the warning is ignored, When 15 minutes pass, Then the Sign in screen returns with focus on its button', async () => {
      const { controller, state } = setup('/')
      await controller.start()
      vi.advanceTimersByTime(15 * MINUTE)
      expect(state().screen).toEqual({ name: 'signIn', notice: TEXT.sessionEnded })
      expect(state().focus).toBe(FOCUS.signInButton)
      expect(state().announcement).toMatchObject({ politeness: 'polite', text: TEXT.sessionEnded })
    })

    it('a session the server already ended returns to Sign in on the next action', async () => {
      const { controller, state } = setup('/', '', [ok(), unauthenticated])
      await controller.start()
      await controller.navigate('/reports/history')
      expect(state().screen).toEqual({ name: 'signIn', notice: TEXT.sessionEnded })
    })

    it('an answer that arrives after the session ended is ignored', async () => {
      let answer: (result: MeResult) => void = () => undefined
      const { controller, state, api } = setup('/')
      await controller.start()
      api.getMe.mockImplementationOnce(() => new Promise<MeResult>((resolve) => (answer = resolve)))
      const pending = controller.staySignedIn()
      vi.advanceTimersByTime(15 * MINUTE)
      answer(ok())
      await pending
      expect(state().screen.name).toBe('signIn')
    })
  })

  describe('Scenario: A session ends after 8 hours even when I stay active (AC-9)', () => {
    it('Given activity every few minutes since 08:00 UTC, When a report opens at 16:01 UTC, Then Sign in returns', async () => {
      const answers: MeResult[] = []
      for (let minute = 0; minute <= 8 * 60; minute += 5) {
        answers.push(
          ok(
            me(['reader'], {
              idleExpiresAt: new Date(NOW + (minute + 15) * MINUTE).toISOString(),
              absoluteExpiresAt: new Date(NOW + 8 * 60 * MINUTE).toISOString(),
            }),
          ),
        )
      }
      const { controller, state } = setup('/', '', answers)
      await controller.start()
      for (let minute = 5; minute < 8 * 60; minute += 5) {
        vi.advanceTimersByTime(5 * MINUTE)
        await controller.navigate(minute % 10 === 0 ? '/reports/daily' : '/reports/history')
        expect(state().screen.name).toBe('app')
      }
      vi.advanceTimersByTime(6 * MINUTE)
      expect(Date.now()).toBe(Date.parse('2026-10-19T16:01:00Z'))
      expect(state().screen).toEqual({ name: 'signIn', notice: TEXT.sessionEnded })
    })

    it('no idle warning is offered when the absolute limit comes first', async () => {
      const ending = me(['reader'], { absoluteExpiresAt: new Date(NOW + MINUTE).toISOString() })
      const { controller, state } = setup('/', '', [ok(ending)])
      await controller.start()
      vi.advanceTimersByTime(MINUTE)
      expect(state().idleWarning).toBe(false)
      expect(state().screen.name).toBe('signIn')
    })
  })

  describe('Scenario: Signing out ends the session (AC-9)', () => {
    it('Given a reader, When Sign out is chosen, Then the session ends and the Sign in screen returns', async () => {
      const { controller, state, api, navigator } = setup('/')
      await controller.start()
      await controller.signOut()
      expect(api.signOut).toHaveBeenCalledTimes(1)
      expect(navigator.replace).toHaveBeenLastCalledWith('/')
      expect(state().screen).toEqual({ name: 'signIn', notice: TEXT.signedOut })
      expect(state().focus).toBe(FOCUS.signInButton)
      expect(state().title).toBe('Sign in – Entra Sign-In Reports')
      vi.advanceTimersByTime(15 * MINUTE)
      expect(state().screen).toEqual({ name: 'signIn', notice: TEXT.signedOut })
    })

    it('a sign-out the server did not complete keeps the dashboard and says so', async () => {
      const { controller, state } = setup('/', '', [ok()], [false])
      await controller.start()
      await controller.signOut()
      expect(state().screen.name).toBe('app')
      expect(state().signOutFailed).toBe(true)
      expect(state().announcement).toMatchObject({ politeness: 'assertive', text: TEXT.signOutFailed })
    })
  })

  it('listeners hear every change and nothing after dispose', async () => {
    const { controller, listener } = setup('/')
    await controller.start()
    expect(listener).toHaveBeenCalled()
    listener.mockClear()
    controller.dispose()
    vi.advanceTimersByTime(15 * MINUTE)
    expect(listener).not.toHaveBeenCalled()
  })

  it('unsubscribing stops a listener', async () => {
    const { controller } = setup('/')
    const other = vi.fn()
    const unsubscribe = controller.subscribe(other)
    unsubscribe()
    await controller.start()
    expect(other).not.toHaveBeenCalled()
  })
})
