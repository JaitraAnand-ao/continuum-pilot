import { describe, expect, it } from 'vitest'
import { fakePorts } from '../test-support/fakePorts'
import { adminOnlyMe, noAccessProblem, readerAdminMe, readerMe } from '../test-support/fixtures'
import { createSessionController, IDLE_WARNING_LEAD_MS, type View } from './controller'

const MINUTE = 60_000
const reader = { status: 'ok', me: readerMe } as const

async function started(pathname: string, results: Parameters<typeof fakePorts>[2], search = '') {
  const ports = fakePorts(pathname, search, results)
  const controller = createSessionController(ports)
  const views: View[] = []
  controller.subscribe(() => views.push(controller.getState().view))
  await controller.start()
  return { ports, controller, views }
}

describe('Feature: Sign in to the dashboard with my Entra ID account, and keep everyone else out', () => {
  describe('@AC-1 Scenario: The sign-in screen explains what it protects', () => {
    it('Given I am not signed in, When I open the dashboard address, Then I see the sign-in screen with focus on its button', async () => {
      const { ports, controller } = await started('/', [{ status: 'unauthenticated' }])
      expect(controller.getState().view).toEqual({ kind: 'signIn', notice: null })
      expect(ports.focused).toEqual(['signin-button'])
      expect(ports.titles.at(-1)).toBe('Sign in – Entra Sign-In Reports')
      expect(controller.getState().announcement).toBeNull()
    })

    it("selecting 'Sign in with Microsoft' navigates to IF-1 and returns to the signing-in frame", async () => {
      const { ports, controller } = await started('/', [{ status: 'unauthenticated' }])
      controller.signIn()
      expect(ports.assigned).toEqual(['/auth/login?returnTo=%2Fsigning-in'])
    })
  })

  describe('@AC-2 Scenario: A reader lands on the Daily report', () => {
    it('Given a reader-only account, When Microsoft sign-in completes, Then I land on the Daily report with focus on its heading', async () => {
      const { ports, controller, views } = await started('/signing-in', [reader])
      expect(views.map((view) => view.kind)).toEqual(['checking', 'dashboard'])
      expect(controller.getState().view).toEqual({ kind: 'dashboard', me: readerMe, page: 'daily', idleWarning: false })
      expect(ports.urls).toEqual(['/reports/daily'])
      expect(ports.titles.at(-1)).toBe('Daily report – Entra Sign-In Reports')
      expect(ports.focused).toEqual(['page-heading'])
    })

    it('keeps the address when the reader opened the Daily report directly', async () => {
      const { ports } = await started('/reports/daily', [reader])
      expect(ports.urls).toEqual([])
    })
  })

  describe('@AC-3 Scenario: A reader who is also a report administrator lands on the Daily report', () => {
    it('Given both app roles, When Microsoft sign-in completes, Then I land on the Daily report', async () => {
      const { controller } = await started('/signing-in', [{ status: 'ok', me: readerAdminMe }])
      expect(controller.getState().view).toMatchObject({ kind: 'dashboard', page: 'daily', me: readerAdminMe })
    })

    it('an administrator without the reader role gets no REPORTS landing (ST-15 adds theirs)', async () => {
      const { ports, controller } = await started('/signing-in', [{ status: 'ok', me: adminOnlyMe }])
      expect(controller.getState().view).toMatchObject({ kind: 'dashboard', page: 'home' })
      expect(ports.urls).toEqual(['/'])
      expect(ports.titles.at(-1)).toBe('Entra Sign-In Reports')
    })
  })

  describe('@AC-4 Scenario: Access is checked after returning from Microsoft', () => {
    it("Given I completed Microsoft sign-in, When claims are checked, Then 'Signing you in' is announced politely", async () => {
      const ports = fakePorts('/signing-in', '', [reader])
      let release: () => void = () => undefined
      ports.api.getMe.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(reader))))
      const controller = createSessionController(ports)
      const done = controller.start()
      expect(controller.getState().view).toEqual({ kind: 'checking' })
      expect(controller.getState().announcement).toMatchObject({ text: 'Signing you in', politeness: 'polite' })
      expect(ports.titles).toEqual(['Signing you in – Entra Sign-In Reports'])
      release()
      await done
      expect(controller.getState().view.kind).toBe('dashboard')
    })

    it('a plain visit is not announced as signing in', async () => {
      const { views } = await started('/', [reader])
      expect(views.map((view) => view.kind)).toEqual(['dashboard'])
    })
  })

  describe('@AC-5 Scenario: Someone outside both groups is turned away', () => {
    it("Given neither group, When sign-in completes, Then 'You don't have access' names the account and is announced assertively", async () => {
      const { ports, controller } = await started('/signing-in', [{ status: 'forbidden', problem: noAccessProblem }])
      expect(controller.getState().view).toEqual({ kind: 'noAccess', message: noAccessProblem.title })
      expect(controller.getState().announcement).toMatchObject({ text: noAccessProblem.title, politeness: 'assertive' })
      expect(ports.titles.at(-1)).toBe('No access – Entra Sign-In Reports')
      expect(ports.focused).toEqual(['page-heading'])
    })

    it("offers 'Sign in with a different account' as a fresh Microsoft sign-in", async () => {
      const { ports, controller } = await started('/signing-in', [{ status: 'forbidden', problem: noAccessProblem }])
      controller.signInWithDifferentAccount()
      expect(ports.assigned).toEqual(['/auth/login?returnTo=%2Fsigning-in&maxAge=0'])
    })

    it('a denial without a readable problem still turns the account away', async () => {
      const { controller } = await started('/', [{ status: 'forbidden', problem: null }])
      expect(controller.getState().view).toEqual({ kind: 'noAccess', message: "You don't have access." })
    })
  })

  describe('@AC-5 Scenario: A denied account cannot reach a report by its address', () => {
    it('Given a denied account, When I open the Daily report for yesterday, Then no report is shown', async () => {
      const { ports, controller } = await started(
        '/reports/daily',
        [{ status: 'forbidden', problem: noAccessProblem }],
        '?date=2026-10-18',
      )
      expect(controller.getState().view.kind).toBe('noAccess')
      expect(ports.api.getMe).toHaveBeenCalledTimes(1)
      expect(ports.timers).toEqual([])
    })
  })

  describe('@AC-6 Scenario: Sign-in does not complete at Microsoft', () => {
    it("Given Microsoft returned an error, When the callback is handled, Then 'Sign-in didn't complete' shows its code, reference and UTC time", async () => {
      const { ports, controller } = await started(
        '/signin-error',
        [],
        '?error=AADSTS50105&ref=7f3c2a91&at=2026-10-19T14:03:07Z',
      )
      expect(controller.getState().view).toEqual({
        kind: 'signInFailed',
        code: 'AADSTS50105',
        reference: '7f3c2a91',
        timestamp: '2026-10-19T14:03:07.000Z',
      })
      expect(controller.getState().announcement).toMatchObject({
        text: "Sign-in didn't complete",
        politeness: 'assertive',
      })
      expect(ports.titles).toEqual(["Sign-in didn't complete – Entra Sign-In Reports"])
      expect(ports.focused).toEqual(['page-heading'])
      expect(ports.api.getMe).not.toHaveBeenCalled()
    })

    it("'Try again' starts Microsoft sign-in again", async () => {
      const { ports, controller } = await started('/signin-error', [], '?error=access_denied')
      controller.tryAgain()
      expect(ports.assigned).toEqual(['/auth/login?returnTo=%2Fsigning-in'])
    })

    it('without a server timestamp, the time handled is shown; without a reference, none is invented', async () => {
      const { controller } = await started('/signin-error', [], '?error=access_denied&at=garbage')
      expect(controller.getState().view).toMatchObject({ reference: null, timestamp: '2026-10-19T08:00:00.000Z' })
      const missing = await started('/signin-error', [], '?error=access_denied')
      expect(missing.controller.getState().view).toMatchObject({ timestamp: '2026-10-19T08:00:00.000Z' })
    })

    it('an error page address without an error code checks the session instead', async () => {
      const { controller } = await started('/signin-error', [{ status: 'unauthenticated' }])
      expect(controller.getState().view.kind).toBe('signIn')
    })
  })

  describe('@AC-7 Report endpoints refuse requests without a session', () => {
    it('a 401 from IF-4 shows the sign-in screen and never the dashboard', async () => {
      const { views } = await started('/reports/daily', [{ status: 'unauthenticated' }])
      expect(views.map((view) => view.kind)).toEqual(['signIn'])
    })
  })

  describe('@AC-9 Scenario: An idle session warns before it ends', () => {
    it("Given 13 idle minutes, When the warning appears, Then a dialog offers 'Stay signed in' and is announced assertively", async () => {
      const { ports, controller } = await started('/signing-in', [reader])
      ports.advance(13 * MINUTE - 1)
      expect(controller.getState().view).toMatchObject({ idleWarning: false })
      ports.advance(1)
      expect(controller.getState().view).toMatchObject({ kind: 'dashboard', idleWarning: true })
      expect(controller.getState().announcement).toMatchObject({
        text: 'Your session is about to end. Select Stay signed in to keep working.',
        politeness: 'assertive',
      })
      expect(ports.focused.at(-1)).toBe('stay-signed-in')
      expect(IDLE_WARNING_LEAD_MS).toBe(2 * MINUTE)
    })

    it("'Stay signed in' renews the session from IF-4, closes the dialog and returns focus", async () => {
      const renewed = {
        ...readerMe,
        idleExpiresAt: new Date(Date.parse(readerMe.idleExpiresAt) + 13 * MINUTE).toISOString(),
      }
      const { ports, controller } = await started('/signing-in', [reader, { status: 'ok', me: renewed }])
      ports.advance(13 * MINUTE)
      await controller.staySignedIn()
      expect(controller.getState().view).toEqual({ kind: 'dashboard', me: renewed, page: 'daily', idleWarning: false })
      expect(ports.focused.at(-1)).toBe('restore')
      expect(ports.urls).toEqual(['/reports/daily'])
      ports.advance(2 * MINUTE)
      expect(controller.getState().view.kind).toBe('dashboard')
      ports.advance(11 * MINUTE)
      expect(controller.getState().view).toMatchObject({ idleWarning: true })
    })

    it("'Stay signed in' after the BFF already ended the session returns to the Sign in screen", async () => {
      const { ports, controller } = await started('/signing-in', [reader, { status: 'unauthenticated' }])
      ports.advance(13 * MINUTE)
      await controller.staySignedIn()
      expect(controller.getState().view).toEqual({ kind: 'signIn', notice: 'expired' })
      expect(ports.focused.at(-1)).toBe('signin-button')
    })
  })

  describe('@AC-9 Scenario: An idle session ends after 15 minutes', () => {
    it('Given I ignore the warning, When 15 minutes pass, Then I am returned to the Sign in screen', async () => {
      const { ports, controller } = await started('/signing-in', [reader])
      ports.advance(15 * MINUTE)
      expect(controller.getState().view).toEqual({ kind: 'signIn', notice: 'expired' })
      expect(controller.getState().announcement).toMatchObject({
        text: 'Your session ended. Sign in again to continue.',
        politeness: 'polite',
      })
      expect(ports.urls.at(-1)).toBe('/')
      expect(ports.focused.at(-1)).toBe('signin-button')
      expect(ports.timers.every((timer) => timer.cancelled)).toBe(true)
    })
  })

  describe('@AC-9 Scenario: A session ends after 8 hours even when I stay active', () => {
    it('Given I signed in at 08:00 UTC and stayed active, When it is 16:00 UTC, Then I am returned to the Sign in screen', async () => {
      const lastHour = {
        ...readerMe,
        idleExpiresAt: new Date(Date.parse(readerMe.absoluteExpiresAt) + 5 * MINUTE).toISOString(),
      }
      const { ports, controller } = await started('/reports/daily', [{ status: 'ok', me: lastHour }])
      ports.clock.now = Date.parse(readerMe.absoluteExpiresAt) - 10 * MINUTE
      ports.advance(10 * MINUTE)
      expect(controller.getState().view).toEqual({ kind: 'signIn', notice: 'expired' })
      expect(ports.timers).toHaveLength(1)
    })

    it('a limit already passed when the page loads ends the session at once', async () => {
      const ports = fakePorts('/reports/daily', '', [reader])
      ports.clock.now = Date.parse(readerMe.absoluteExpiresAt) + MINUTE
      const controller = createSessionController(ports)
      await controller.start()
      expect(ports.timers.map((timer) => timer.ms)).toEqual([ports.clock.now, ports.clock.now])
    })
  })

  describe('@AC-9 Scenario: Signing out ends the session', () => {
    it("Given I am signed in, When I choose 'Sign out', Then IF-5 ends the session and I am on the Sign in screen", async () => {
      const { ports, controller } = await started('/signing-in', [reader])
      await controller.signOut()
      expect(ports.api.signOut).toHaveBeenCalledTimes(1)
      expect(controller.getState().view).toEqual({ kind: 'signIn', notice: 'signedOut' })
      expect(controller.getState().announcement).toMatchObject({ text: 'You are signed out.', politeness: 'polite' })
      expect(ports.urls.at(-1)).toBe('/')
      expect(ports.focused.at(-1)).toBe('signin-button')
      ports.advance(16 * MINUTE)
      expect(controller.getState().view).toEqual({ kind: 'signIn', notice: 'signedOut' })
    })

    it('a session check still in flight when signing out is ignored', async () => {
      const ports = fakePorts('/', '', [])
      let release: () => void = () => undefined
      ports.api.getMe.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(reader))))
      const controller = createSessionController(ports)
      const checking = controller.start()
      await controller.signOut()
      release()
      await checking
      expect(controller.getState().view).toEqual({ kind: 'signIn', notice: 'signedOut' })
    })
  })

  describe('IF-4 unavailable', () => {
    it("shows 'We couldn't check your access', announced assertively, and 'Try again' checks once more", async () => {
      const { ports, controller, views } = await started('/', [{ status: 'unavailable' }, reader])
      expect(controller.getState().view).toEqual({ kind: 'unavailable' })
      expect(controller.getState().announcement).toMatchObject({ politeness: 'assertive' })
      expect(ports.titles.at(-1)).toBe('Sign-in unavailable – Entra Sign-In Reports')
      await controller.recheck()
      expect(views.map((view) => view.kind)).toEqual(['unavailable', 'loading', 'dashboard'])
    })

    it('a denial while renewing the session turns the account away and stops the timers', async () => {
      const { ports, controller } = await started('/', [reader, { status: 'forbidden', problem: noAccessProblem }])
      ports.advance(13 * MINUTE)
      await controller.staySignedIn()
      expect(controller.getState().view.kind).toBe('noAccess')
      expect(ports.timers.every((timer) => timer.cancelled)).toBe(true)
    })

    it('an idle warning timer firing after the dashboard is gone does nothing', async () => {
      const { ports, controller } = await started('/', [reader])
      const warning = ports.timers[0]
      await controller.signOut()
      warning?.task()
      expect(controller.getState().view).toEqual({ kind: 'signIn', notice: 'signedOut' })
    })

    it('unsubscribed listeners hear nothing more', async () => {
      const ports = fakePorts('/', '', [reader])
      const controller = createSessionController(ports)
      let calls = 0
      const unsubscribe = controller.subscribe(() => calls++)
      unsubscribe()
      await controller.start()
      expect(calls).toBe(0)
    })
  })
})
