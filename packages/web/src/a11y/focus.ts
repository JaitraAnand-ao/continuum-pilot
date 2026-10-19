/** Moves focus to the element with this id, reporting whether it was there to receive it. */
export function focusById(doc: Document, id: string): boolean {
  const element = doc.getElementById(id)
  if (!element) return false
  element.focus()
  return true
}
