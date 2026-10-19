/** Moves focus to the element with this id, reporting whether it was there to receive it. */
export function focusById(doc: Document, id: string): boolean {
  const element = doc.getElementById(id)
  if (!element) return false
  element.focus()
  return true
}

const TABBABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

/** Keeps Tab and Shift+Tab inside `container`, wrapping from either end to the other. A modal
 * <dialog> makes the page behind it inert but still lets Tab leave it for the browser. */
export function containTab(event: KeyboardEvent, container: HTMLElement): void {
  if (event.key !== 'Tab') return
  const tabbable = [...container.querySelectorAll<HTMLElement>(TABBABLE)]
  const first = tabbable[0]
  const last = tabbable[tabbable.length - 1]
  if (!first || !last) return
  const active = container.ownerDocument.activeElement
  if (event.shiftKey ? active !== first : active !== last) return
  event.preventDefault()
  ;(event.shiftKey ? last : first).focus()
}
