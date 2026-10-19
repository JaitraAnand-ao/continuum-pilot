import { createElement, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { App, Screen } from './App'
import type { SessionController, SessionState, View } from './session/controller'
import { noAccessProblem, readerMe } from './test-support/fixtures'
import { render, textOf } from './test-support/render'

function controllerShowing(state: SessionState): SessionController {
  return {
    getState: () => state,
    subscribe: () => () => undefined,
    start: vi.fn(async () => undefined),
    signIn: vi.fn(),
    signInWithDifferentAccount: vi.fn(),
    tryAgain: vi.fn(),
    recheck: vi.fn(async () => undefined),
    staySignedIn: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
  }
}

const liveRegion = (html: string, testId: string) => {
  const start = html.indexOf(`data-testid="${testId}"`)
  return textOf(html.slice(start, html.indexOf('</div>', start)).replace(/^[^>]*>/, ''))
}

describe('App renders the session state', () => {
  it.each<[View, string]>([
    [{ kind: 'loading' }, ''],
    [{ kind: 'signIn', notice: null }, 'Sign in with Microsoft'],
    [{ kind: 'checking' }, 'Signing you in… Checking your access with Microsoft Entra ID.'],
    [
      { kind: 'signInFailed', code: 'AADSTS50105', reference: 'r1', timestamp: '2026-10-19T14:03:07.000Z' },
      'AADSTS50105',
    ],
    [{ kind: 'noAccess', message: noAccessProblem.title }, noAccessProblem.title],
    [{ kind: 'unavailable' }, "We couldn't check your access"],
    [{ kind: 'dashboard', me: readerMe, page: 'daily', idleWarning: false }, 'Daily report'],
  ])('%j', (view, text) => {
    const html = render(createElement(App, { controller: controllerShowing({ view, announcement: null }) }))
    expect(textOf(html)).toContain(text)
    expect(html.match(/<main/g)).toHaveLength(1)
  })

  it('a loading page is marked busy and shows nothing yet', () => {
    const html = render(
      createElement(App, { controller: controllerShowing({ view: { kind: 'loading' }, announcement: null }) }),
    )
    expect(html).toContain('<main aria-busy="true"></main>')
  })
})

describe('announcements go through one polite and one assertive live region', () => {
  it("'Signing you in' is announced politely (AC-4)", () => {
    const html = render(
      createElement(App, {
        controller: controllerShowing({
          view: { kind: 'checking' },
          announcement: { id: 1, text: 'Signing you in', politeness: 'polite' },
        }),
      }),
    )
    expect(html).toContain('role="status" aria-live="polite"')
    expect(liveRegion(html, 'live-polite')).toBe('Signing you in')
    expect(liveRegion(html, 'live-assertive')).toBe('')
  })

  it('the idle warning is announced assertively (AC-9)', () => {
    const html = render(
      createElement(App, {
        controller: controllerShowing({
          view: { kind: 'dashboard', me: readerMe, page: 'daily', idleWarning: true },
          announcement: { id: 2, text: 'Your session is about to end.', politeness: 'assertive' },
        }),
      }),
    )
    expect(liveRegion(html, 'live-assertive')).toBe('Your session is about to end.')
    expect(liveRegion(html, 'live-polite')).toBe('')
    expect(html).toContain('role="dialog"')
  })
})

describe('screen actions reach the session controller', () => {
  const props = (view: View) => {
    const controller = controllerShowing({ view, announcement: null })
    const element = Screen({ view, controller }) as ReactElement<Record<string, () => void>>
    return { controller, props: element.props }
  }

  it("'Sign in with Microsoft' and 'Try again' start sign-in", () => {
    const signIn = props({ kind: 'signIn', notice: null })
    signIn.props.onSignIn?.()
    expect(signIn.controller.signIn).toHaveBeenCalled()
    const failed = props({ kind: 'signInFailed', code: 'x', reference: null, timestamp: '2026-10-19T00:00:00.000Z' })
    failed.props.onTryAgain?.()
    expect(failed.controller.tryAgain).toHaveBeenCalled()
  })

  it("the denied frame's actions sign in again or sign out", () => {
    const denied = props({ kind: 'noAccess', message: 'm' })
    denied.props.onDifferentAccount?.()
    denied.props.onSignOut?.()
    expect(denied.controller.signInWithDifferentAccount).toHaveBeenCalled()
    expect(denied.controller.signOut).toHaveBeenCalled()
  })

  it("'Try again' on the unavailable frame checks access again", () => {
    const unavailable = props({ kind: 'unavailable' })
    unavailable.props.onTryAgain?.()
    expect(unavailable.controller.recheck).toHaveBeenCalled()
  })

  it("the shell's 'Stay signed in' and 'Sign out' reach the controller", () => {
    const dashboard = props({ kind: 'dashboard', me: readerMe, page: 'daily', idleWarning: true })
    dashboard.props.onStay?.()
    dashboard.props.onSignOut?.()
    expect(dashboard.controller.staySignedIn).toHaveBeenCalled()
    expect(dashboard.controller.signOut).toHaveBeenCalled()
  })
})
