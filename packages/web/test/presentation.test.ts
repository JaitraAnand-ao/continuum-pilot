import { describe, expect, it, vi } from 'vitest'
import { applyTitle, FocusManager, focusTargetFor, titleFor, type FocusDocument } from '../src/presentation'
import type { AppState } from '../src/session/controller'
import { meFor, NO_ACCESS } from './fixtures'

/* A document stand-in: focus() records itself as document.activeElement. */
function fakeDocument(ids: string[]) {
  const doc = {
    title: '',
    activeElement: null as unknown,
    elements: new Map<string, { id: string; isConnected: boolean; focus: () => void }>(),
    getElementById: (id: string) => doc.elements.get(id) ?? null,
  }
  for (const id of ids) {
    const element = { id, isConnected: true, focus: () => (doc.activeElement = element) }
    doc.elements.set(id, element)
  }
  return doc satisfies FocusDocument
}

const signedIn = (warning: boolean): AppState => ({
  kind: 'signed-in',
  me: meFor(['reader']),
  screen: 'daily',
  warning,
})
const failed: AppState = { kind: 'failed', failure: { code: 'x', reference: 'y', occurredAt: 'z' } }

describe('page titles', () => {
  it.each<[AppState, string]>([
    [{ kind: 'signed-out' }, 'Sign in – Entra Sign-In Reports'],
    [{ kind: 'checking' }, 'Signing in – Entra Sign-In Reports'],
    [{ kind: 'denied', message: NO_ACCESS.title }, 'No access – Entra Sign-In Reports'],
    [failed, "Sign-in didn't complete – Entra Sign-In Reports"],
    [{ kind: 'unavailable' }, "Couldn't check access – Entra Sign-In Reports"],
    [signedIn(false), 'Daily report – Entra Sign-In Reports'],
    [
      { kind: 'signed-in', me: meFor(['reader']), screen: 'history', warning: false },
      'Report history – Entra Sign-In Reports',
    ],
  ])('%o is titled %s', (state, title) => {
    expect(titleFor(state)).toBe(title)
    const doc = fakeDocument([])
    applyTitle(doc, state)
    expect(doc.title).toBe(title)
  })
})

describe('focus after each transition', () => {
  const ids = [
    'sign-in-button',
    'signing-in-heading',
    'no-access-heading',
    'sign-in-failed-heading',
    'unavailable-heading',
    'screen-heading',
    'stay-signed-in',
  ]

  it.each<[AppState, string]>([
    [{ kind: 'signed-out' }, 'sign-in-button'],
    [{ kind: 'checking' }, 'signing-in-heading'],
    [{ kind: 'denied', message: NO_ACCESS.title }, 'no-access-heading'],
    [failed, 'sign-in-failed-heading'],
    [{ kind: 'unavailable' }, 'unavailable-heading'],
    [signedIn(false), 'screen-heading'],
    [signedIn(true), 'stay-signed-in'],
  ])('%o puts document.activeElement on #%s', (state, id) => {
    expect(focusTargetFor(state)).toBe(id)
    const doc = fakeDocument(ids)
    new FocusManager().update(doc, focusTargetFor(state))
    expect((doc.activeElement as { id: string }).id).toBe(id)
  })

  it('AC-2: checking then landing moves focus from the progress heading to the Daily report heading', () => {
    const doc = fakeDocument(ids)
    const focus = new FocusManager()
    focus.update(doc, focusTargetFor({ kind: 'checking' }))
    focus.update(doc, focusTargetFor(signedIn(false)))
    expect((doc.activeElement as { id: string }).id).toBe('screen-heading')
  })

  it('does not move focus again when the target is unchanged', () => {
    const doc = fakeDocument(ids)
    const focus = new FocusManager()
    focus.update(doc, 'screen-heading')
    const other = { focus: vi.fn() }
    doc.activeElement = other
    focus.update(doc, 'screen-heading')
    expect(doc.activeElement).toBe(other)
  })

  it('AC-9: closing the idle warning returns focus to where it was', () => {
    const doc = fakeDocument(ids)
    const focus = new FocusManager()
    focus.update(doc, 'screen-heading')
    const link = { id: 'nav-link', isConnected: true, focus: () => (doc.activeElement = link) }
    link.focus()
    focus.update(doc, 'stay-signed-in')
    expect((doc.activeElement as { id: string }).id).toBe('stay-signed-in')
    focus.update(doc, 'screen-heading')
    expect(doc.activeElement).toBe(link)
  })

  it('AC-9: falls back to the screen heading when the earlier element is gone', () => {
    const doc = fakeDocument(ids)
    const focus = new FocusManager()
    const gone = { id: 'gone', isConnected: false, focus: vi.fn() }
    doc.activeElement = gone
    focus.update(doc, 'stay-signed-in')
    focus.update(doc, 'screen-heading')
    expect(gone.focus).not.toHaveBeenCalled()
    expect((doc.activeElement as { id: string }).id).toBe('screen-heading')
  })

  it('AC-9: an expired warning moves focus to the Sign in button', () => {
    const doc = fakeDocument(ids)
    const focus = new FocusManager()
    doc.activeElement = null
    focus.update(doc, 'stay-signed-in')
    focus.update(doc, 'sign-in-button')
    expect((doc.activeElement as { id: string }).id).toBe('sign-in-button')
  })
})
