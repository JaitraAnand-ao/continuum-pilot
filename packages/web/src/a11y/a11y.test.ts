import { describe, expect, it, vi } from 'vitest'
import { createAnnouncer } from './announcer'
import { containTab, focusById } from './focus'

function fakeDocument() {
  const appended: FakeElement[] = []
  const doc = {
    createElement: (tag: string) => new FakeElement(tag),
    body: { appendChild: (element: FakeElement) => appended.push(element) },
  }
  return { doc, appended }
}

class FakeElement {
  attributes: Record<string, string> = {}
  textContent = ''
  className = ''
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string) {
    this.attributes[name] = value
  }
}

describe('the announcer owns one polite and one assertive live region', () => {
  it('creates both regions once, visually hidden', () => {
    const { doc, appended } = fakeDocument()
    createAnnouncer(doc as unknown as Document)
    expect(appended.map((element) => [element.tag, element.attributes, element.className])).toEqual([
      ['div', { 'aria-live': 'polite', 'aria-atomic': 'true', role: 'status' }, 'sr-only'],
      ['div', { 'aria-live': 'assertive', 'aria-atomic': 'true', role: 'alert' }, 'sr-only'],
    ])
  })

  it('speaks politely or assertively, never both at once', () => {
    const { doc, appended } = fakeDocument()
    const announcer = createAnnouncer(doc as unknown as Document)
    const [polite, assertive] = appended as [FakeElement, FakeElement]
    announcer.announce('Signing you in', 'polite')
    expect([polite.textContent, assertive.textContent]).toEqual(['Signing you in', ''])
    announcer.announce("You don't have access. Signed in as p.ruiz@fabrikam.com.", 'assertive')
    expect([polite.textContent, assertive.textContent]).toEqual([
      '',
      "You don't have access. Signed in as p.ruiz@fabrikam.com.",
    ])
  })

  it('repeats an identical message so it is heard again', () => {
    const { doc, appended } = fakeDocument()
    const announcer = createAnnouncer(doc as unknown as Document)
    const [polite] = appended as [FakeElement]
    announcer.announce('Signing you in', 'polite')
    announcer.announce('Signing you in', 'polite')
    expect(polite.textContent).toBe('Signing you in ')
    announcer.announce('Signing you in', 'polite')
    expect(polite.textContent).toBe('Signing you in')
  })
})

describe('focusById', () => {
  it('moves focus to the element and reports it', () => {
    const focus = vi.fn()
    const doc = { getElementById: (id: string) => (id === 'main-heading' ? { focus } : null) }
    expect(focusById(doc as unknown as Document, 'main-heading')).toBe(true)
    expect(focus).toHaveBeenCalledOnce()
    expect(focusById(doc as unknown as Document, 'missing')).toBe(false)
  })
})

describe('containTab keeps Tab inside a dialog', () => {
  function dialog(count: number) {
    const doc: { activeElement: unknown } = { activeElement: null }
    const items = Array.from({ length: count }, (_, index) => ({
      index,
      focus: vi.fn(() => (doc.activeElement = items[index])),
    }))
    const container = { ownerDocument: doc, querySelectorAll: () => items }
    const press = (key: string, shiftKey = false) => {
      const event = { key, shiftKey, preventDefault: vi.fn() }
      containTab(event as unknown as KeyboardEvent, container as unknown as HTMLElement)
      return event.preventDefault.mock.calls.length > 0
    }
    return { doc, items, press }
  }

  it('wraps Tab from the last element to the first, and Shift+Tab from the first to the last', () => {
    const { doc, items, press } = dialog(2)
    doc.activeElement = items[1]
    expect(press('Tab')).toBe(true)
    expect(doc.activeElement).toBe(items[0])
    expect(press('Tab', true)).toBe(true)
    expect(doc.activeElement).toBe(items[1])
  })

  it('leaves Tab between elements, and every other key, to the browser', () => {
    const { doc, items, press } = dialog(2)
    doc.activeElement = items[0]
    expect(press('Tab')).toBe(false)
    expect(press('Enter')).toBe(false)
    doc.activeElement = items[1]
    expect(press('Tab', true)).toBe(false)
  })

  it('does nothing in a container with nothing to focus', () => {
    expect(dialog(0).press('Tab')).toBe(false)
  })
})
