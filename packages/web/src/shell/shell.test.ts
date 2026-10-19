import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { adminOnlyMe, readerAdminMe, readerMe } from '../test-support/fixtures'
import { countOf, render, textOf } from '../test-support/render'
import { AccountMenu } from './AccountMenu'
import { AppShell } from './AppShell'
import { IdleWarningDialog } from './IdleWarningDialog'

const shell = (props: Partial<Parameters<typeof AppShell>[0]> = {}) =>
  render(
    createElement(AppShell, {
      me: readerMe,
      page: 'daily',
      idleWarning: false,
      onStay: vi.fn(),
      onSignOut: vi.fn(),
      ...props,
    }),
  )

describe('@AC-2 A reader lands on the Daily report', () => {
  const html = shell()

  it('the main heading is the Daily report and takes focus', () => {
    expect(html).toContain('<h1 id="page-heading" tabindex="-1">Daily report</h1>')
  })

  it('the side navigation shows Daily report, Suspicious activity and Report history under REPORTS, and no SETTINGS', () => {
    const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'))
    expect(textOf(nav)).toBe('REPORTS Daily report Suspicious activity Report history')
    expect(nav).toContain('<a href="/reports/daily" aria-current="page">Daily report</a>')
    expect(html).not.toContain('SETTINGS')
  })

  it('the top bar names the reader role and the signed-in account', () => {
    expect(textOf(html)).toContain('Roles: Reader m.duarte@contoso.com')
  })
})

describe('@AC-3 A reader who is also a report administrator', () => {
  it('the top bar names both roles', () => {
    const header = shell({ me: readerAdminMe })
    expect(textOf(header.slice(0, header.indexOf('</header>')))).toContain('Roles: Reader, Report administrator')
  })

  it('an administrator without the reader role gets no report navigation', () => {
    const html = shell({ me: adminOnlyMe, page: 'home' })
    expect(html).not.toContain('<nav')
    expect(html).toContain('<h1 id="page-heading" tabindex="-1">Entra Sign-In Reports</h1>')
  })
})

describe('@AC-9 account menu and idle warning', () => {
  it("the account menu is a closed disclosure holding 'Sign out'", () => {
    const html = render(
      createElement(AccountMenu, { account: 'm.duarte@contoso.com', displayName: 'Marta Duarte', onSignOut: vi.fn() }),
    )
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-controls="account-menu-panel"')
    expect(html).toContain('aria-label="Account menu, m.duarte@contoso.com"')
    expect(html).toMatch(/<div id="account-menu-panel" class="account-menu__panel" hidden="">/)
    expect(html).toMatch(/<button[^>]*>Sign out<\/button>/)
  })

  it('opened, the menu shows the person and its panel', () => {
    const html = shell({ accountMenuOpen: true })
    expect(html).toContain('aria-expanded="true"')
    expect(html).not.toContain('hidden=""')
    expect(textOf(html)).toContain('Marta Duarte Sign out')
  })

  it("the idle dialog is a labelled modal offering 'Stay signed in' first", () => {
    const html = render(createElement(IdleWarningDialog, { onStay: vi.fn(), onSignOut: vi.fn() }))
    expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby="idle-warning-heading"')
    expect(html.match(/<button[^>]*>([^<]*)<\/button>/g)?.map(textOf)).toEqual(['Stay signed in', 'Sign out'])
    expect(html).toContain('<button id="stay-signed-in"')
    expect(textOf(html)).toContain('Your session is about to end')
  })

  it('while the warning shows, the page behind it is inert', () => {
    const html = shell({ idleWarning: true })
    expect(html).toContain('<div class="shell" inert="">')
    expect(countOf(html, /role="dialog"/)).toBe(1)
    expect(shell()).not.toMatch(/inert|role="dialog"/)
  })
})
