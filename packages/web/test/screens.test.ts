import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../src/App'
import { AppView } from '../src/AppView'
import type { AppState, SessionActions } from '../src/session/controller'
import { SessionController } from '../src/session/controller'
import { meFor, NO_ACCESS } from './fixtures'

const actions = (): SessionActions => ({
  signIn: vi.fn(),
  signOut: vi.fn(async () => {}),
  signInWithDifferentAccount: vi.fn(async () => {}),
  staySignedIn: vi.fn(async () => {}),
  tryAgain: vi.fn(),
  recheck: vi.fn(async () => {}),
})

const render = (state: AppState, given = actions()) =>
  renderToStaticMarkup(createElement(AppView, { state, actions: given }))

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((match) => text(match[1]!))

const element = (html: string, id: string) => html.match(new RegExp(`<(\\w+)[^>]*id="${id}"[^>]*>`))?.[0] ?? ''

describe('Feature: Sign in to the dashboard with my Entra ID account, and keep everyone else out', () => {
  describe('Scenario: The sign-in screen explains what it protects (AC-1)', () => {
    const html = render({ kind: 'signed-out' })

    it('shows a single Sign in with Microsoft button, which takes focus', () => {
      expect(buttons(html)).toEqual(['Sign in with Microsoft'])
      expect(element(html, 'sign-in-button')).toMatch(/^<button/)
    })

    it('says what the reports hold and who can open them', () => {
      expect(text(html)).toContain(
        'Reports contain personal data. Only the reader group and report administrators can open them.',
      )
    })

    it("says the application is read-only and uses the organization's Entra ID account", () => {
      expect(text(html)).toContain('This application is read-only.')
      expect(text(html)).toContain("It uses your organization's Entra ID account.")
    })
  })

  describe('Scenario: Access is checked after returning from Microsoft (AC-4)', () => {
    const html = render({ kind: 'checking' })

    it('reads Signing you in… Checking your access with Microsoft Entra ID.', () => {
      expect(text(html)).toContain('Signing you in… Checking your access with Microsoft Entra ID.')
    })

    it('announces Signing you in politely', () => {
      const region = html.match(/<p role="status" aria-live="polite"[^>]*>(.*?)<\/p>/)
      expect(text(region?.[1] ?? '')).toBe('Signing you in')
    })
  })

  describe('Scenario: A reader lands on the Daily report (AC-2)', () => {
    const html = render({ kind: 'signed-in', me: meFor(['reader']), screen: 'daily', warning: false })

    it('lands on the Daily report with a focusable heading', () => {
      expect(element(html, 'screen-heading')).toMatch(/^<h1[^>]*tabindex="-1"/)
      expect(html).toMatch(/<h1 id="screen-heading" tabindex="-1">Daily report<\/h1>/)
    })

    it('shows Daily report, Suspicious activity and Report history under REPORTS, and no SETTINGS group', () => {
      const navs = [...html.matchAll(/<nav[^>]*>(.*?)<\/nav>/g)].map((match) => text(match[1]!))
      expect(navs).toEqual(['REPORTS Daily report Suspicious activity Report history'])
      expect(text(html)).not.toContain('SETTINGS')
      expect(html).toContain('<a href="/reports/daily" aria-current="page">Daily report</a>')
    })

    it('names the account and the reader role on the top bar', () => {
      expect(text(html)).toContain('Signed in as m.duarte@contoso.com')
      expect(text(html)).toContain('Roles: Reader')
      expect(text(html)).not.toContain('Report administrator')
    })

    it('offers Sign out from the account menu', () => {
      expect(html).toMatch(/<details class="account-menu"><summary>Account<\/summary><button[^>]*>Sign out<\/button>/)
    })

    it('shows no idle warning yet', () => {
      expect(html).not.toContain('alertdialog')
      expect(html).not.toContain('inert')
    })
  })

  describe('Scenario: A reader who is also a report administrator lands on the Daily report (AC-3)', () => {
    const html = render({ kind: 'signed-in', me: meFor(['reader', 'config.read']), screen: 'daily', warning: false })

    it('lands on the Daily report and names both roles', () => {
      expect(text(html)).toContain('Daily report')
      expect(text(html)).toContain('Roles: Reader, Report administrator')
    })
  })

  describe('An administrator without the reader role', () => {
    const html = render({ kind: 'signed-in', me: meFor(['config.read']), screen: 'settings', warning: false })

    it('sees no REPORTS group', () => {
      expect(html).not.toContain('<nav')
      expect(text(html)).toContain('Roles: Report administrator')
      expect(html).toContain('>Detection settings</h1>')
    })
  })

  describe('Scenario: Someone outside both groups is turned away (AC-5)', () => {
    const given = actions()
    const html = render({ kind: 'denied', message: NO_ACCESS.title }, given)

    it("shows You don't have access and names the signed-in account, assertively", () => {
      expect(html).toMatch(/<h1 id="no-access-heading" tabindex="-1">.*You don&#x27;t have access<\/h1>/)
      expect(html).toContain('<p role="alert">You don&#x27;t have access. Signed in as j.outsider@contoso.com.</p>')
    })

    it('tells them to ask their Entra administrator to add them', () => {
      expect(text(html)).toContain('Ask your Entra administrator to add you to the reader group.')
    })

    it('offers Sign in with a different account and Sign out', () => {
      expect(buttons(html)).toEqual(['Sign in with a different account', 'Sign out'])
    })

    it('shows no report figures or navigation', () => {
      expect(html).not.toContain('<nav')
      expect(text(html)).not.toContain('Daily report')
    })
  })

  describe('Scenario: Sign-in does not complete at Microsoft (AC-6)', () => {
    const failure = { code: 'AADSTS50105', reference: 'abc123', occurredAt: '2026-10-19 08:00:00 UTC' }
    const html = render({ kind: 'failed', failure })

    it("reads Sign-in didn't complete with the Entra error code", () => {
      expect(text(html)).toContain("Sign-in didn't complete")
      expect(text(html)).toContain('Microsoft Entra ID returned error code AADSTS50105 .')
    })

    it('says nothing was changed', () => {
      expect(text(html)).toContain('Nothing was changed.')
    })

    it('shows an error reference and a UTC timestamp that can be copied', () => {
      expect(html).toContain('<dt>Error reference</dt><dd><code class="copyable">abc123</code></dd>')
      expect(html).toContain('<dt>Time (UTC)</dt><dd><code class="copyable">2026-10-19 08:00:00 UTC</code></dd>')
    })

    it('offers Try again', () => {
      expect(buttons(html)).toEqual(['Try again'])
    })
  })

  describe('When the access check cannot complete', () => {
    const html = render({ kind: 'unavailable' })

    it('says so, and that nothing was changed, with Try again', () => {
      expect(text(html)).toContain("We couldn't check your access")
      expect(text(html)).toContain("The sign-in service didn't answer. Nothing was changed.")
      expect(buttons(html)).toEqual(['Try again'])
    })
  })

  describe('Scenario: An idle session warns before it ends (AC-9)', () => {
    const html = render({ kind: 'signed-in', me: meFor(['reader']), screen: 'daily', warning: true })

    it('opens an alertdialog, announced assertively, offering Stay signed in', () => {
      expect(html).toMatch(
        /<div role="alertdialog" aria-modal="true" aria-labelledby="idle-warning-heading" aria-describedby="idle-warning-detail"/,
      )
      expect(element(html, 'stay-signed-in')).toMatch(/^<button/)
      expect(buttons(html.slice(html.indexOf('alertdialog')))).toEqual(['Stay signed in', 'Sign out'])
    })

    it('names when the session will end, from the server limit', () => {
      expect(text(html)).toContain('You will be signed out at 08:15 UTC unless you stay signed in.')
    })

    it('makes the rest of the shell inert', () => {
      expect(html).toMatch(/<div class="shell" inert="">/)
    })
  })

  describe('every status carries an icon hidden from assistive tech', () => {
    it.each<AppState>([
      { kind: 'signed-out' },
      { kind: 'checking' },
      { kind: 'denied', message: NO_ACCESS.title },
      { kind: 'failed', failure: { code: 'x', reference: 'y', occurredAt: 'z' } },
      { kind: 'unavailable' },
      { kind: 'signed-in', me: meFor(['reader']), screen: 'daily', warning: true },
    ])('%o', (state) => {
      expect(render(state)).toMatch(
        /<svg class="status-icon[^"]*" viewBox="0 0 24 24" aria-hidden="true" focusable="false">/,
      )
    })
  })

  describe('the screens call the session actions', () => {
    type Props = Record<string, unknown>
    /* Walks the rendered element tree without a DOM and collects every onClick handler. */
    function handlers(state: AppState, given: SessionActions): Array<() => void> {
      const found: Array<() => void> = []
      const visit = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(visit)
        if (typeof node !== 'object' || node === null || !('props' in node)) return
        const { type, props } = node as { type: unknown; props: Props }
        if (typeof props.onClick === 'function') found.push(props.onClick as () => void)
        if (typeof type === 'function') visit((type as (p: Props) => unknown)(props))
        visit(props.children)
      }
      visit(createElement(AppView, { state, actions: given }))
      return found
    }

    it('wires every button on every screen', () => {
      const given = actions()
      const states: AppState[] = [
        { kind: 'signed-out' },
        { kind: 'denied', message: NO_ACCESS.title },
        { kind: 'failed', failure: { code: 'x', reference: 'y', occurredAt: 'z' } },
        { kind: 'unavailable' },
        { kind: 'signed-in', me: meFor(['reader']), screen: 'daily', warning: true },
      ]
      states.forEach((state) => handlers(state, given).forEach((click) => click()))
      expect(given.signIn).toHaveBeenCalledOnce()
      expect(given.signInWithDifferentAccount).toHaveBeenCalledOnce()
      expect(given.tryAgain).toHaveBeenCalledOnce()
      expect(given.recheck).toHaveBeenCalledOnce()
      expect(given.staySignedIn).toHaveBeenCalledOnce()
      /* denied Sign out, account-menu Sign out and the idle dialog's Sign out */
      expect(given.signOut).toHaveBeenCalledTimes(3)
    })
  })

  describe('App', () => {
    it('renders the controller state, starting with the access check', () => {
      const controller = new SessionController(
        { getMe: vi.fn(), logout: vi.fn() },
        { pathname: () => '/', search: () => '', assign: vi.fn(), replace: vi.fn() },
        { now: () => 0, setTimeout: vi.fn(), clearTimeout: vi.fn() },
      )
      const doc = { title: '', activeElement: null, getElementById: () => null }
      expect(text(renderToStaticMarkup(createElement(App, { controller, doc })))).toContain('Signing you in…')
    })
  })
})

describe('package entry', () => {
  it('exports the app, its view and the session controller', async () => {
    const entry = await import('../src/index')
    expect(entry).toMatchObject({ App, AppView, SessionController })
  })
})
