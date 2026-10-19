import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { noAccessProblem } from '../test-support/fixtures'
import { countOf, render, textOf } from '../test-support/render'
import { CheckingScreen } from './CheckingScreen'
import { NoAccessScreen } from './NoAccessScreen'
import { formatUtc, SignInFailedScreen } from './SignInFailedScreen'
import { SignInScreen } from './SignInScreen'
import { UnavailableScreen } from './UnavailableScreen'

describe('SCR-1 Sign in frame (AC-1)', () => {
  const html = render(createElement(SignInScreen, { notice: null, onSignIn: vi.fn() }))

  it("shows one 'Sign in with Microsoft' button, the focus target", () => {
    expect(countOf(html, /<button/)).toBe(1)
    expect(html).toContain(
      '<button id="signin-button" type="button" class="button button--primary">Sign in with Microsoft</button>',
    )
  })

  it('says the reports hold personal data only the reader group and report administrators can open', () => {
    expect(textOf(html)).toContain(
      'These reports contain personal data. Only the reader group and report administrators can open them.',
    )
  })

  it("says the application is read-only and uses the organization's Entra ID account", () => {
    expect(textOf(html)).toContain("This application is read-only. It uses your organization's Entra ID account.")
  })

  it('has a focusable page heading and no notice on a first visit', () => {
    expect(html).toContain('<h1 id="page-heading" tabindex="-1">Entra Sign-In Reports</h1>')
    expect(textOf(html)).not.toMatch(/signed out|session ended/)
  })

  it.each([
    ['signedOut', 'You are signed out.'],
    ['expired', 'Your session ended. Sign in again to continue.'],
  ] as const)('after %s it says so with text and an icon', (notice, text) => {
    const withNotice = render(createElement(SignInScreen, { notice, onSignIn: vi.fn() }))
    expect(textOf(withNotice)).toContain(text)
    expect(countOf(withNotice, /<svg[^>]*aria-hidden="true"/)).toBe(2)
  })
})

describe('SCR-1 signing-in frame (AC-4)', () => {
  it("reads 'Signing you in… Checking your access with Microsoft Entra ID.' and is marked busy", () => {
    const html = render(createElement(CheckingScreen))
    expect(textOf(html)).toBe('Signing you in… Checking your access with Microsoft Entra ID.')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('<h1 id="page-heading" tabindex="-1">')
  })
})

describe('SCR-1 denied frame (AC-5)', () => {
  const html = render(
    createElement(NoAccessScreen, { message: noAccessProblem.title, onDifferentAccount: vi.fn(), onSignOut: vi.fn() }),
  )

  it("shows 'You don't have access' and the BFF's line naming the signed-in account, verbatim", () => {
    expect(textOf(html)).toContain("You don't have access You don't have access. Signed in as p.ruiz@fabrikam.com.")
  })

  it('tells the person to ask their Entra administrator to add them', () => {
    expect(textOf(html)).toContain('Ask your Entra administrator to add you to the reader group.')
  })

  it("offers 'Sign in with a different account' and 'Sign out' and no report data", () => {
    expect(html.match(/<button[^>]*>([^<]*)<\/button>/g)?.map(textOf)).toEqual([
      'Sign in with a different account',
      'Sign out',
    ])
    expect(html).not.toMatch(/<nav|<table|Daily report/)
  })
})

describe('SCR-1 sign-in failed frame (AC-6)', () => {
  const props = {
    code: 'AADSTS50105',
    reference: '7f3c2a91',
    timestamp: '2026-10-19T14:03:07.000Z',
    onTryAgain: vi.fn(),
  }
  const html = render(createElement(SignInFailedScreen, props))

  it("reads 'Sign-in didn't complete' with the Entra error code and that nothing was changed", () => {
    expect(textOf(html)).toContain(
      "Sign-in didn't complete Microsoft Entra ID returned error code AADSTS50105. Nothing was changed.",
    )
  })

  it('shows a copyable error reference and UTC timestamp', () => {
    expect(html).toContain('<code>7f3c2a91</code>')
    expect(html).toContain('<time dateTime="2026-10-19T14:03:07.000Z">2026-10-19 14:03:07 UTC</time>')
    expect(textOf(html)).toContain('Error reference 7f3c2a91 Time (UTC) 2026-10-19 14:03:07 UTC')
  })

  it("offers 'Try again'", () => {
    expect(html).toMatch(/<button[^>]*>Try again<\/button>/)
  })

  it('says when the BFF sent no reference rather than inventing one', () => {
    expect(textOf(render(createElement(SignInFailedScreen, { ...props, reference: null })))).toContain(
      'Error reference Not provided',
    )
  })

  it('formats UTC times for reading', () => {
    expect(formatUtc('2026-01-02T03:04:05.000Z')).toBe('2026-01-02 03:04:05 UTC')
  })
})

describe('SCR-1 unavailable frame', () => {
  it("says the access check could not run, that nothing changed, and offers 'Try again'", () => {
    const html = render(createElement(UnavailableScreen, { onTryAgain: vi.fn() }))
    expect(textOf(html)).toBe(
      "We couldn't check your access The dashboard could not reach the sign-in service. Nothing was changed. Try again",
    )
    expect(countOf(html, /<svg[^>]*aria-hidden="true"/)).toBe(1)
  })
})
