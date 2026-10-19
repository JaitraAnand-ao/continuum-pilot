import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { AppView, type Actions } from './AppView'
import type { Screen } from '../app/controller'
import type { Me } from '../api/client'
import { render } from '../test-support/render'
import { adminOnlyMe, readerAdminMe, readerMe } from '../test-support/fixtures'

const actions = (): Actions => ({
  signIn: vi.fn(),
  signOut: vi.fn(),
  signInWithDifferentAccount: vi.fn(),
  retry: vi.fn(),
  navigate: vi.fn(),
  staySignedIn: vi.fn(),
})

const view = (state: Screen) => render(createElement(AppView, { state, actions: actions() }))
const app = (me: unknown, route: 'daily' | 'suspicious' | 'history' | 'none' = 'daily', idleWarning = false) =>
  view({ kind: 'app', me: me as Me, route, idleWarning })

describe('SCR-1 Sign in (AC-1)', () => {
  it('shows one Sign in with Microsoft button, the personal-data notice and the read-only and Entra ID lines', () => {
    const screen = view({ kind: 'sign-in' })
    expect(screen.texts('button')).toEqual(['Sign in with Microsoft'])
    expect(screen.texts('h1')).toEqual(['Sign in'])
    expect(screen.text).toContain(
      'Reports contain personal data. Only members of the reader group and report administrators can open them.',
    )
    expect(screen.text).toContain('This application is read-only.')
    expect(screen.text).toContain("It uses your organization's Entra ID account.")
  })

  it('the button carries the id that receives focus', () => {
    expect(view({ kind: 'sign-in' }).byId('sign-in-button')).toMatch(/^<button\b/)
  })

  it('the personal-data notice carries text and an icon', () => {
    const notice = view({ kind: 'sign-in' }).html.match(
      /<section[^>]*aria-labelledby="personal-data-label"[\s\S]*?<\/section>/,
    )
    expect(notice?.[0]).toMatch(/<svg[^>]*aria-hidden="true"/)
    expect(notice?.[0]).toContain('Personal data')
  })

  it('after signing out or expiry it says why', () => {
    expect(view({ kind: 'sign-in', notice: 'signed-out' }).text).toContain('You have been signed out.')
    expect(view({ kind: 'sign-in', notice: 'expired' }).text).toContain(
      'Your session ended. Sign in again to continue.',
    )
    expect(view({ kind: 'sign-in' }).text).not.toContain('You have been signed out.')
  })
})

describe('SCR-1 Signing you in (AC-4)', () => {
  it("reads 'Signing you in… Checking your access with Microsoft Entra ID.' with a focusable heading", () => {
    const screen = view({ kind: 'checking' })
    expect(screen.text).toBe('Signing you in… Checking your access with Microsoft Entra ID.')
    expect(screen.byId('signing-in-heading')).toMatch(/^<h1\b[^>]*tabindex="-1"/)
    expect(screen.html).toContain('aria-busy="true"')
  })

  it('announces through the shared live region, not an ad-hoc one', () => {
    expect(view({ kind: 'checking' }).html).not.toContain('aria-live')
  })
})

describe('SCR-1 No access (AC-5)', () => {
  const title = "You don't have access. Signed in as p.ruiz@fabrikam.com."

  it('names the signed-in account with the server title and tells me to ask my Entra administrator', () => {
    const screen = view({ kind: 'no-access', title })
    expect(screen.texts('h1')).toEqual(["You don't have access"])
    expect(screen.byId('no-access-heading')).toMatch(/tabindex="-1"/)
    expect(screen.text).toContain(title)
    expect(screen.text).toContain('Ask your Entra administrator to add you to the reader group.')
  })

  it("offers 'Sign in with a different account' and 'Sign out', and no report data", () => {
    const screen = view({ kind: 'no-access', title })
    expect(screen.texts('button')).toEqual(['Sign in with a different account', 'Sign out'])
    expect(screen.text).not.toContain('Daily report')
    expect(screen.html).not.toContain('<nav')
  })

  it('carries an icon beside the text', () => {
    expect(view({ kind: 'no-access', title }).html).toMatch(/<svg[^>]*aria-hidden="true"/)
  })
})

describe("SCR-1 Sign-in didn't complete (AC-6)", () => {
  it('shows the Entra error code, that nothing was changed, the reference, a UTC timestamp and Try again', () => {
    const screen = view({
      kind: 'sign-in-error',
      error: { code: 'AADSTS50105', reference: '7f3c9a1e', occurredAt: '2026-10-19T08:12:03.000Z' },
    })
    expect(screen.texts('h1')).toEqual(["Sign-in didn't complete"])
    expect(screen.byId('sign-in-error-heading')).toMatch(/tabindex="-1"/)
    expect(screen.texts('dt')).toEqual(['Entra error code', 'Error reference', 'Time (UTC)'])
    expect(screen.texts('dd')).toEqual(['AADSTS50105', '7f3c9a1e', '2026-10-19 08:12:03 UTC'])
    expect(screen.text).toContain('Nothing was changed.')
    expect(screen.texts('button')).toEqual(['Try again'])
    expect(screen.html).toMatch(/<svg[^>]*aria-hidden="true"/)
  })

  it('the reference and timestamp are selectable code a person can copy', () => {
    const screen = view({
      kind: 'sign-in-error',
      error: { code: 'AADSTS50105', reference: '7f3c9a1e', occurredAt: '2026-10-19T08:12:03.000Z' },
    })
    expect(screen.texts('code')).toEqual(['AADSTS50105', '7f3c9a1e', '2026-10-19 08:12:03 UTC'])
  })

  it('leaves out the rows the callback did not carry', () => {
    const screen = view({ kind: 'sign-in-error', error: { code: 'unknown' } })
    expect(screen.texts('dt')).toEqual(['Entra error code'])
  })
})

describe('service unavailable', () => {
  it("says the access check failed and offers 'Try again'", () => {
    const screen = view({ kind: 'unavailable' })
    expect(screen.texts('h1')).toEqual(["We couldn't check your access"])
    expect(screen.byId('unavailable-heading')).toMatch(/tabindex="-1"/)
    expect(screen.text).toContain('Nothing was changed. Try again in a moment.')
    expect(screen.texts('button')).toEqual(['Try again'])
  })
})

describe('the signed-in frame (AC-2, AC-3)', () => {
  it('a reader lands on the Daily report: heading focusable, REPORTS navigation only', () => {
    const screen = app(readerMe)
    expect(screen.texts('h1')).toEqual(['Daily report'])
    expect(screen.byId('main-heading')).toMatch(/^<h1\b[^>]*tabindex="-1"/)
    expect(screen.texts('h2')).toEqual(['REPORTS'])
    expect(screen.texts('a')).toEqual(['Daily report', 'Suspicious activity', 'Report history'])
    expect(screen.text).not.toContain('SETTINGS')
  })

  it('marks the current page in the navigation', () => {
    const screen = app(readerMe, 'suspicious')
    expect(screen.tags('a')).toEqual([
      '<a href="/reports/daily">',
      '<a href="/reports/suspicious" aria-current="page">',
      '<a href="/reports/history">',
    ])
    expect(screen.texts('h1')).toEqual(['Suspicious activity'])
    expect(app(readerMe, 'history').texts('h1')).toEqual(['Report history'])
  })

  it('the top bar names the account and the reader role', () => {
    const screen = app(readerMe)
    expect(screen.text).toContain('m.duarte@contoso.com')
    expect(screen.texts('li').slice(0, 1)).toEqual(['Reader'])
  })

  it('the top bar names both roles for someone holding the reader and administrator claims', () => {
    const header = app(readerAdminMe).html.match(/<header[\s\S]*?<\/header>/)?.[0] ?? ''
    expect([...header.matchAll(/<li[^>]*>([^<]*)<\/li>/g)].map((match) => match[1])).toEqual([
      'Reader',
      'Report administrator',
    ])
  })

  it("offers 'Sign out' from the account menu", () => {
    const screen = app(readerMe)
    expect(screen.texts('summary')).toEqual(['Account menu'])
    expect(screen.html).toMatch(/<details[\s\S]*<button[^>]*>Sign out<\/button>[\s\S]*<\/details>/)
  })

  it('shows no report figures; the Daily report content is not part of this story', () => {
    expect(app(readerMe).html).not.toMatch(/<table/)
  })

  it('an administrator without the reader role sees no report and is told why', () => {
    const screen = app(adminOnlyMe, 'none')
    expect(screen.html).not.toContain('<nav')
    expect(screen.texts('h1')).toEqual(['Entra Sign-In Reports'])
    expect(screen.text).toContain('Reports need the reader role.')
    expect(screen.texts('li')).toEqual(['Report administrator'])
  })
})

describe('the idle warning dialog (AC-9)', () => {
  it("offers 'Stay signed in' and 'Sign out' in a labelled modal alert dialog", () => {
    const screen = app(readerMe, 'daily', true)
    const dialog = screen.html.match(/<div[^>]*role="alertdialog"[^>]*>/)?.[0]
    expect(dialog).toContain('aria-modal="true"')
    expect(dialog).toContain('aria-labelledby="idle-warning-title"')
    expect(dialog).toContain('aria-describedby="idle-warning-body"')
    expect(screen.text).toContain('Your session is about to end')
    expect(screen.text).toContain('You will be signed out at 08:15 UTC unless you stay signed in.')
    expect(screen.byId('stay-signed-in')).toMatch(/^<button\b/)
    expect(screen.texts('button').slice(-2)).toEqual(['Stay signed in', 'Sign out'])
  })

  it('makes the page behind it inert', () => {
    expect(app(readerMe, 'daily', true).html).toMatch(/<div[^>]*inert=""/)
    expect(app(readerMe).html).not.toContain('inert')
    expect(app(readerMe).html).not.toContain('alertdialog')
  })
})
