import { describe, expect, it, vi } from 'vitest'
import { SessionController, type Ports } from './controller'
import type { MeResult } from '../api/client'
import { adminOnlyMe, readerAdminMe, readerMe, SIGNED_IN_AT } from '../test-support/fixtures'

const minute = 60_000

function harness(...answers: MeResult[]) {
  let now = SIGNED_IN_AT
  const timers = new Map<number, { at: number; fn: () => void }>()
  let nextTimer = 1
  const events: string[] = []
  const getMe = vi.fn(async (): Promise<MeResult> => {
    const answer = answers.shift()
    if (!answer) throw new Error('unexpected /api/v1/me')
    return answer
  })
  const signOut = vi.fn(async () => {
    events.push('POST /auth/logout')
  })
  const ports: Ports = {
    api: { getMe, signOut },
    now: () => now,
    setTimer: (fn, ms) => {
      timers.set(nextTimer, { at: now + ms, fn })
      return nextTimer++
    },
    clearTimer: (handle) => {
      timers.delete(handle as number)
    },
    redirect: (url) => events.push(`redirect ${url}`),
    pushUrl: (path) => events.push(`push ${path}`),
    setTitle: (title) => events.push(`title ${title}`),
    focus: (id) => events.push(`focus #${id}`),
    announce: (text, politeness) => events.push(`${politeness} ${text}`),
  }
  const controller = new SessionController(ports)
  /** Moves the clock on, firing every timer that falls due. */
  const advance = (ms: number) => {
    const until = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      now = due[1].at
      due[1].fn()
    }
    now = until
  }
  const take = () => events.splice(0)
  return { controller, getMe, signOut, advance, take, timers, setNow: (at: number) => (now = at) }
}

const readerSignedIn: MeResult = { kind: 'signed-in', me: readerMe as never }
const deniedTitle = "You don't have access. Signed in as p.ruiz@fabrikam.com."

describe('Scenario: The sign-in screen explains what it protects (AC-1)', () => {
  it('Given I am not signed in, When I open the dashboard address, Then the Sign in screen has focus on its button', async () => {
    const { controller, take } = harness({ kind: 'signed-out' })
    await controller.start({ pathname: '/', search: '' })
    expect(controller.getState()).toEqual({ kind: 'sign-in' })
    expect(take()).toEqual([
      'title Signing in – Entra Sign-In Reports',
      'focus #signing-in-heading',
      'polite Signing you in',
      'title Sign in – Entra Sign-In Reports',
      'focus #sign-in-button',
    ])
  })

  it('opening /signin shows the Sign in screen without asking the server', async () => {
    const { controller, getMe, take } = harness()
    await controller.start({ pathname: '/signin', search: '' })
    expect(controller.getState()).toEqual({ kind: 'sign-in' })
    expect(getMe).not.toHaveBeenCalled()
    expect(take()).toEqual(['title Sign in – Entra Sign-In Reports', 'focus #sign-in-button'])
  })

  it('selecting Sign in with Microsoft starts IF-1, returning to the address that was asked for', async () => {
    const { controller, take } = harness({ kind: 'signed-out' })
    await controller.start({ pathname: '/reports/history', search: '' })
    take()
    controller.signIn()
    expect(take()).toEqual(['redirect /auth/login?returnTo=%2Freports%2Fhistory'])
  })
})

describe('Scenario: A reader lands on the Daily report (AC-2)', () => {
  it('Given a reader, When Microsoft sign-in completes, Then the Daily report has focus on its heading', async () => {
    const { controller, take } = harness(readerSignedIn)
    await controller.start({ pathname: '/reports/daily', search: '' })
    expect(controller.getState()).toEqual({ kind: 'app', me: readerMe, route: 'daily', idleWarning: false })
    expect(take().slice(3)).toEqual(['title Daily report – Entra Sign-In Reports', 'focus #main-heading'])
  })
})

describe('Scenario: A reader who is also a report administrator lands on the Daily report (AC-3)', () => {
  it('lands on the Daily report with the server payload unchanged', async () => {
    const { controller } = harness({ kind: 'signed-in', me: readerAdminMe as never })
    await controller.start({ pathname: '/', search: '' })
    expect(controller.getState()).toEqual({ kind: 'app', me: readerAdminMe, route: 'daily', idleWarning: false })
  })

  it('an administrator without the reader role is not shown a report', async () => {
    const { controller, take } = harness({ kind: 'signed-in', me: adminOnlyMe as never })
    await controller.start({ pathname: '/reports/daily', search: '' })
    expect(controller.getState()).toEqual({ kind: 'app', me: adminOnlyMe, route: 'none', idleWarning: false })
    expect(take().slice(3)).toEqual(['title Entra Sign-In Reports', 'focus #main-heading'])
  })
})

describe('Scenario: Access is checked after returning from Microsoft (AC-4)', () => {
  it('While the claims are checked, Then the checking state shows and Signing you in is announced politely', async () => {
    const { controller, take } = harness(readerSignedIn)
    const started = controller.start({ pathname: '/reports/daily', search: '' })
    expect(controller.getState()).toEqual({ kind: 'checking' })
    expect(take()).toEqual([
      'title Signing in – Entra Sign-In Reports',
      'focus #signing-in-heading',
      'polite Signing you in',
    ])
    await started
  })
})

describe('Scenario: Someone outside both groups is turned away (AC-5)', () => {
  it('shows the denied frame titled No access, focused, with the server title announced assertively', async () => {
    const { controller, take } = harness({ kind: 'no-access', title: deniedTitle })
    await controller.start({ pathname: '/', search: '' })
    expect(controller.getState()).toEqual({ kind: 'no-access', title: deniedTitle })
    expect(take().slice(3)).toEqual([
      'title No access – Entra Sign-In Reports',
      'focus #no-access-heading',
      `assertive ${deniedTitle}`,
    ])
  })

  it('Sign out ends the session and returns to the Sign in screen', async () => {
    const { controller, take } = harness({ kind: 'no-access', title: deniedTitle })
    await controller.start({ pathname: '/', search: '' })
    take()
    await controller.signOut()
    expect(controller.getState()).toEqual({ kind: 'sign-in', notice: 'signed-out' })
    expect(take()).toEqual([
      'POST /auth/logout',
      'push /signin',
      'title Sign in – Entra Sign-In Reports',
      'focus #sign-in-button',
      'polite You have been signed out.',
    ])
  })

  it('Sign in with a different account ends this session and forces a fresh Microsoft sign-in', async () => {
    const { controller, take } = harness({ kind: 'no-access', title: deniedTitle })
    await controller.start({ pathname: '/', search: '' })
    take()
    await controller.signInWithDifferentAccount()
    expect(take()).toEqual(['POST /auth/logout', 'redirect /auth/login?returnTo=%2Freports%2Fdaily&maxAge=0'])
  })
})

describe('Scenario: A denied account cannot reach a report by its address (AC-5)', () => {
  it('opening the Daily report address shows no report, only the denied frame', async () => {
    const { controller } = harness({ kind: 'no-access', title: deniedTitle })
    await controller.start({ pathname: '/reports/daily', search: '?date=2026-10-18' })
    expect(controller.getState().kind).toBe('no-access')
  })
})

describe('Scenario: Sign-in does not complete at Microsoft (AC-6)', () => {
  it('shows the failure, focused and announced assertively, and Try again restarts sign-in', async () => {
    const { controller, getMe, take } = harness()
    await controller.start({
      pathname: '/signin',
      search: '?error=AADSTS50105&ref=7f3c9a1e&at=2026-10-19T08:12:03Z',
    })
    expect(controller.getState()).toEqual({
      kind: 'sign-in-error',
      error: { code: 'AADSTS50105', reference: '7f3c9a1e', occurredAt: '2026-10-19T08:12:03.000Z' },
    })
    expect(getMe).not.toHaveBeenCalled()
    expect(take()).toEqual([
      "title Sign-in didn't complete – Entra Sign-In Reports",
      'focus #sign-in-error-heading',
      "assertive Sign-in didn't complete",
    ])
    controller.signIn()
    expect(take()).toEqual(['redirect /auth/login?returnTo=%2Freports%2Fdaily'])
  })
})

describe('the service cannot be reached', () => {
  it('says so, focused and assertively, and Try again checks access again', async () => {
    const { controller, take } = harness({ kind: 'unavailable' }, readerSignedIn)
    await controller.start({ pathname: '/reports/suspicious', search: '' })
    expect(controller.getState()).toEqual({ kind: 'unavailable' })
    expect(take().slice(3)).toEqual([
      'title Service unavailable – Entra Sign-In Reports',
      'focus #unavailable-heading',
      "assertive We couldn't check your access",
    ])
    await controller.retry()
    expect(controller.getState()).toEqual({ kind: 'app', me: readerMe, route: 'suspicious', idleWarning: false })
  })
})

describe('navigating inside the dashboard', () => {
  it('re-checks the session on every move and focuses the new heading', async () => {
    const { controller, take } = harness(readerSignedIn, readerSignedIn)
    await controller.start({ pathname: '/', search: '' })
    take()
    await controller.navigate('history')
    expect(controller.getState()).toEqual({ kind: 'app', me: readerMe, route: 'history', idleWarning: false })
    expect(take()).toEqual([
      'push /reports/history',
      'title Report history – Entra Sign-In Reports',
      'focus #main-heading',
    ])
  })

  it('following the browser history back does not push a new entry', async () => {
    const { controller, take } = harness(readerSignedIn, readerSignedIn)
    await controller.start({ pathname: '/reports/history', search: '' })
    take()
    await controller.restore({ pathname: '/reports/daily', search: '' })
    expect(take()).toEqual(['title Daily report – Entra Sign-In Reports', 'focus #main-heading'])
  })

  it('restoring the /signin address shows the Sign in screen', async () => {
    const { controller } = harness(readerSignedIn)
    await controller.start({ pathname: '/', search: '' })
    await controller.restore({ pathname: '/signin', search: '' })
    expect(controller.getState()).toEqual({ kind: 'sign-in' })
  })
})

describe('Scenario: An idle session warns before it ends (AC-9)', () => {
  it('Given 13 idle minutes, Then a dialog offers Stay signed in, focused and announced assertively', async () => {
    const { controller, advance, take } = harness(readerSignedIn)
    await controller.start({ pathname: '/', search: '' })
    take()
    advance(13 * minute - 1)
    expect(take()).toEqual([])
    advance(1)
    expect(controller.getState()).toEqual({ kind: 'app', me: readerMe, route: 'daily', idleWarning: true })
    expect(take()).toEqual([
      'focus #stay-signed-in',
      'assertive Your session is about to end. You will be signed out at 08:15 UTC unless you stay signed in.',
    ])
  })

  it('Stay signed in renews the session from the server and moves the limits on', async () => {
    const renewed = {
      ...readerMe,
      idleExpiresAt: new Date(SIGNED_IN_AT + 28 * minute).toISOString(),
    }
    const { controller, advance, take } = harness(readerSignedIn, { kind: 'signed-in', me: renewed as never })
    await controller.start({ pathname: '/', search: '' })
    advance(13 * minute)
    take()
    await controller.staySignedIn()
    expect(controller.getState()).toEqual({ kind: 'app', me: renewed, route: 'daily', idleWarning: false })
    expect(take()).toEqual(['focus #main-heading', "polite You're still signed in."])
    advance(2 * minute)
    expect(controller.getState().kind).toBe('app')
    advance(11 * minute)
    expect(take()).toEqual([
      'focus #stay-signed-in',
      'assertive Your session is about to end. You will be signed out at 08:28 UTC unless you stay signed in.',
    ])
  })

  it('Stay signed in after the server already ended the session returns to Sign in', async () => {
    const { controller, advance } = harness(readerSignedIn, { kind: 'signed-out' })
    await controller.start({ pathname: '/', search: '' })
    advance(13 * minute)
    await controller.staySignedIn()
    expect(controller.getState()).toEqual({ kind: 'sign-in', notice: 'expired' })
  })

  it('Sign out from the warning ends the session', async () => {
    const { controller, advance, signOut } = harness(readerSignedIn)
    await controller.start({ pathname: '/', search: '' })
    advance(13 * minute)
    await controller.signOut()
    expect(signOut).toHaveBeenCalledOnce()
    expect(controller.getState()).toEqual({ kind: 'sign-in', notice: 'signed-out' })
  })
})

describe('Scenario: An idle session ends after 15 minutes (AC-9)', () => {
  it('Given the warning is ignored, When 15 minutes pass, Then the Sign in screen returns', async () => {
    const { controller, advance, take } = harness(readerSignedIn)
    await controller.start({ pathname: '/', search: '' })
    advance(13 * minute)
    take()
    advance(2 * minute)
    expect(controller.getState()).toEqual({ kind: 'sign-in', notice: 'expired' })
    expect(take()).toEqual([
      'push /signin',
      'title Sign in – Entra Sign-In Reports',
      'focus #sign-in-button',
      'polite Your session ended. Sign in again to continue.',
    ])
  })
})

describe('Scenario: A session ends after 8 hours even when I stay active (AC-9)', () => {
  it('When a report is opened at 16:01 UTC, Then the server answers 401 and the Sign in screen returns', async () => {
    const { controller, setNow, take } = harness(readerSignedIn, { kind: 'signed-out' })
    await controller.start({ pathname: '/', search: '' })
    setNow(SIGNED_IN_AT + 8 * 60 * minute + minute)
    take()
    await controller.navigate('daily')
    expect(controller.getState()).toEqual({ kind: 'sign-in', notice: 'expired' })
  })

  it('the absolute limit ends the session on the client too', async () => {
    const lateMe = {
      ...readerMe,
      idleExpiresAt: new Date(SIGNED_IN_AT + 8 * 60 * minute + 5 * minute).toISOString(),
    }
    const { controller, advance, take } = harness({ kind: 'signed-in', me: lateMe as never })
    await controller.start({ pathname: '/', search: '' })
    take()
    advance(8 * 60 * minute)
    expect(controller.getState()).toEqual({ kind: 'sign-in', notice: 'expired' })
    expect(take()).not.toContain('focus #stay-signed-in')
  })
})

describe('Scenario: Signing out ends the session (AC-9)', () => {
  it('ends the server session, clears the timers and returns to the Sign in screen', async () => {
    const { controller, timers, take } = harness(readerSignedIn)
    await controller.start({ pathname: '/', search: '' })
    take()
    expect(timers.size).toBe(2)
    await controller.signOut()
    expect(timers.size).toBe(0)
    expect(take()).toEqual([
      'POST /auth/logout',
      'push /signin',
      'title Sign in – Entra Sign-In Reports',
      'focus #sign-in-button',
      'polite You have been signed out.',
    ])
  })
})

describe('subscribers', () => {
  it('hear every state change until they unsubscribe; dispose clears timers', async () => {
    const { controller, timers } = harness(readerSignedIn)
    const listener = vi.fn()
    const unsubscribe = controller.subscribe(listener)
    await controller.start({ pathname: '/', search: '' })
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    controller.dispose()
    expect(timers.size).toBe(0)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
