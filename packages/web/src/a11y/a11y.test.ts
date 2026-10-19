import { describe, expect, it, vi } from 'vitest'
import { createAnnouncer } from './announcer'
import { focusById } from './focus'

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
