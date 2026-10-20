import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Api } from './api/client'
import { App, applyView } from './App'
import { HistoryController } from './history/controller'
import { SessionController } from './session/controller'

const controller = () =>
  new SessionController({
    api: { getMe: vi.fn(), signOut: vi.fn() } as unknown as Api,
    clock: { now: () => 0, setTimeout: vi.fn(), clearTimeout: vi.fn() },
    navigator: { path: () => '/', search: () => '', push: vi.fn(), replace: vi.fn(), assign: vi.fn() },
  })

const history = () =>
  new HistoryController({
    api: { getReportHistory: vi.fn() },
    session: { notify: vi.fn(), recheck: vi.fn() },
  })

describe('App', () => {
  it('renders the controller state with both live regions mounted', () => {
    const html = renderToStaticMarkup(
      createElement(App, {
        controller: controller(),
        history: history(),
        doc: { title: '', getElementById: () => null },
      }),
    )
    expect(html).toContain('<h1>Signing you in…</h1>')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-live="assertive"')
  })
})

describe('applyView', () => {
  it('sets the page title and moves focus to the requested element', () => {
    const focus = vi.fn()
    const doc = { title: '', getElementById: vi.fn(() => ({ focus })) }
    applyView(doc, { title: 'No access – Entra Sign-In Reports', focus: 'no-access-heading' })
    expect(doc.title).toBe('No access – Entra Sign-In Reports')
    expect(doc.getElementById).toHaveBeenCalledWith('no-access-heading')
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('leaves focus alone when nothing asked for it or the element is gone', () => {
    const doc = { title: '', getElementById: vi.fn(() => null) }
    applyView(doc, { title: 'Signing you in – Entra Sign-In Reports', focus: null })
    expect(doc.getElementById).not.toHaveBeenCalled()
    expect(() => applyView(doc, { title: 't', focus: 'gone' })).not.toThrow()
  })
})
