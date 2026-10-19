import { describe, expect, it, vi } from 'vitest'
import { meFor, NO_ACCESS } from './fixtures'
import { harness } from './harness'

const minutes = (n: number) => n * 60 * 1000

describe('Feature: Sign in to the dashboard with my Entra ID account, and keep everyone else out', () => {
  it('AC-1: someone without a session is shown the Sign in screen', async () => {
    const h = harness()
    h.answer({ status: 401 })
    await h.controller.start()
    expect(h.controller.getState()).toEqual({ kind: 'signed-out' })
  })

  it('AC-1: Sign in with Microsoft starts IF-1 and returns to the address that was opened', async () => {
    const h = harness('/reports/daily', '?date=2026-10-18')
    h.answer({ status: 401 })
    await h.controller.start()
    h.controller.signIn()
    expect(h.nav.assign).toHaveBeenCalledWith('/auth/login?returnTo=%2Freports%2Fdaily%3Fdate%3D2026-10-18')
  })

  it('AC-4: access is being checked while /api/v1/me is answering', async () => {
    const h = harness()
    const states: string[] = []
    h.controller.subscribe(() => states.push(h.controller.getState().kind))
    expect(h.controller.getState()).toEqual({ kind: 'checking' })
    h.answer({ status: 200, me: meFor(['reader']) })
    await h.controller.start()
    expect(states).toEqual(['checking', 'signed-in'])
  })

  it('AC-2: a reader lands on the Daily report', async () => {
    const h = harness()
    const me = meFor(['reader'])
    h.answer({ status: 200, me })
    await h.controller.start()
    expect(h.controller.getState()).toEqual({ kind: 'signed-in', me, screen: 'daily', warning: false })
    expect(h.nav.replace).toHaveBeenCalledWith('/reports/daily')
  })

  it('AC-3: a reader who is also an administrator lands on the Daily report', async () => {
    const h = harness()
    h.answer({ status: 200, me: meFor(['reader', 'config.read']) })
    await h.controller.start()
    expect(h.controller.getState()).toMatchObject({ kind: 'signed-in', screen: 'daily' })
  })

  it('keeps the address when it already names the landing screen', async () => {
    const h = harness('/reports/history')
    h.answer({ status: 200, me: meFor(['reader']) })
    await h.controller.start()
    expect(h.controller.getState()).toMatchObject({ screen: 'history' })
    expect(h.nav.replace).not.toHaveBeenCalled()
  })

  it('AC-5: an account in neither group is turned away with the server-named account', async () => {
    const h = harness()
    h.answer({ status: 403, problem: NO_ACCESS })
    await h.controller.start()
    expect(h.controller.getState()).toEqual({
      kind: 'denied',
      message: "You don't have access. Signed in as j.outsider@contoso.com.",
    })
  })

  it('AC-5: a denied account opening the Daily report address gets no report screen', async () => {
    const h = harness('/reports/daily', '?date=2026-10-18')
    h.answer({ status: 403, problem: NO_ACCESS })
    await h.controller.start()
    expect(h.controller.getState().kind).toBe('denied')
    expect(h.api.getMe).toHaveBeenCalledTimes(1)
  })

  it('AC-5: Sign in with a different account ends this session, then starts IF-1 again', async () => {
    const h = harness()
    h.answer({ status: 403, problem: NO_ACCESS })
    await h.controller.start()
    await h.controller.signInWithDifferentAccount()
    expect(h.api.logout).toHaveBeenCalledOnce()
    expect(h.nav.assign).toHaveBeenCalledWith('/auth/login')
    expect(h.api.logout.mock.invocationCallOrder[0]!).toBeLessThan(h.nav.assign.mock.invocationCallOrder[0]!)
  })

  it('AC-5: Sign out from the denied screen returns to Sign in', async () => {
    const h = harness()
    h.answer({ status: 403, problem: NO_ACCESS })
    await h.controller.start()
    await h.controller.signOut()
    expect(h.controller.getState()).toEqual({ kind: 'signed-out' })
  })

  it('AC-6: a failed Microsoft sign-in shows the callback error', async () => {
    const h = harness('/signin/error', '?error=AADSTS50105&ref=abc123&at=2026-10-19T08:00:00Z')
    await h.controller.start()
    expect(h.controller.getState()).toEqual({
      kind: 'failed',
      failure: { code: 'AADSTS50105', reference: 'abc123', occurredAt: '2026-10-19 08:00:00 UTC' },
    })
    expect(h.api.getMe).not.toHaveBeenCalled()
    h.controller.tryAgain()
    expect(h.nav.assign).toHaveBeenCalledWith('/auth/login')
  })

  it('shows the access check as unavailable when /api/v1/me fails, and checks again on request', async () => {
    const h = harness()
    h.answer({ status: 'error' }, { status: 200, me: meFor(['reader']) })
    await h.controller.start()
    expect(h.controller.getState()).toEqual({ kind: 'unavailable' })
    await h.controller.recheck()
    expect(h.controller.getState().kind).toBe('signed-in')
  })

  it('AC-9: the idle warning opens at 13 minutes idle', async () => {
    const h = harness()
    h.answer({ status: 200, me: meFor(['reader']) })
    await h.controller.start()
    h.advance(minutes(13) - 1)
    expect(h.controller.getState()).toMatchObject({ warning: false })
    h.advance(1)
    expect(h.controller.getState()).toMatchObject({ kind: 'signed-in', warning: true })
  })

  it('AC-9: Stay signed in renews the session from the server and closes the warning', async () => {
    const h = harness()
    h.answer({ status: 200, me: meFor(['reader']) })
    await h.controller.start()
    h.advance(minutes(13))
    const renewed = meFor(['reader'], { idleExpiresAt: '2026-10-19T08:28:00Z' })
    h.answer({ status: 200, me: renewed })
    await h.controller.staySignedIn()
    expect(h.controller.getState()).toMatchObject({ me: renewed, warning: false })
    h.advance(minutes(2))
    expect(h.controller.getState()).toMatchObject({ kind: 'signed-in', warning: false })
  })

  it('AC-9: Stay signed in after the server ended the session returns to Sign in', async () => {
    const h = harness()
    h.answer({ status: 200, me: meFor(['reader']) })
    await h.controller.start()
    h.advance(minutes(13))
    h.answer({ status: 401 })
    await h.controller.staySignedIn()
    expect(h.controller.getState()).toEqual({ kind: 'signed-out' })
    expect(h.timerPending()).toBe(false)
  })

  it('AC-9: an ignored warning ends the session at 15 minutes and returns to Sign in', async () => {
    const h = harness()
    h.answer({ status: 200, me: meFor(['reader']) })
    await h.controller.start()
    h.advance(minutes(15))
    expect(h.controller.getState()).toEqual({ kind: 'signed-out' })
    expect(h.address.pathname).toBe('/')
    expect(h.timerPending()).toBe(false)
    h.controller.signIn()
    expect(h.nav.assign).toHaveBeenLastCalledWith('/auth/login')
  })

  it('AC-9: an active session still ends at 8 hours', async () => {
    const h = harness()
    h.answer({
      status: 200,
      me: meFor(['reader'], { idleExpiresAt: '2026-10-19T16:10:00Z', absoluteExpiresAt: '2026-10-19T16:00:00Z' }),
    })
    await h.controller.start()
    h.advance(Date.parse('2026-10-19T16:01:00Z') - Date.parse('2026-10-19T08:00:00Z'))
    expect(h.controller.getState()).toEqual({ kind: 'signed-out' })
  })

  it('AC-9: a session the server already ended is not shown as signed in', async () => {
    const h = harness()
    h.answer({ status: 200, me: meFor(['reader'], { idleExpiresAt: '2026-10-19T07:59:00Z' }) })
    await h.controller.start()
    expect(h.controller.getState()).toEqual({ kind: 'signed-out' })
  })

  it('AC-9: signing out ends the session and returns to Sign in', async () => {
    const h = harness()
    h.answer({ status: 200, me: meFor(['reader']) })
    await h.controller.start()
    await h.controller.signOut()
    expect(h.api.logout).toHaveBeenCalledOnce()
    expect(h.controller.getState()).toEqual({ kind: 'signed-out' })
    expect(h.address.pathname).toBe('/')
    expect(h.timerPending()).toBe(false)
  })

  it('stops notifying and timing once disposed', async () => {
    const h = harness()
    const listener = vi.fn()
    const unsubscribe = h.controller.subscribe(listener)
    h.answer({ status: 200, me: meFor(['reader']) })
    await h.controller.start()
    h.controller.dispose()
    expect(h.timerPending()).toBe(false)
    unsubscribe()
    listener.mockClear()
    await h.controller.recheck()
    expect(listener).not.toHaveBeenCalled()
  })
})
