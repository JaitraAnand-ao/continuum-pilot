/* The one place the SPA speaks to screen readers: a polite and an assertive live region,
 * created once and kept in the document so announcements are never lost to a re-render.
 * Screens never add their own aria-live. */
export type Politeness = 'polite' | 'assertive'

export interface Announcer {
  announce(text: string, politeness: Politeness): void
}

export function createAnnouncer(doc: Document): Announcer {
  const region = (politeness: Politeness) => {
    const element = doc.createElement('div')
    element.setAttribute('aria-live', politeness)
    element.setAttribute('aria-atomic', 'true')
    element.setAttribute('role', politeness === 'polite' ? 'status' : 'alert')
    element.className = 'sr-only'
    doc.body.appendChild(element)
    return element
  }
  const regions: Record<Politeness, HTMLElement> = { polite: region('polite'), assertive: region('assertive') }

  return {
    announce(text, politeness) {
      const target = regions[politeness]
      const other = regions[politeness === 'polite' ? 'assertive' : 'polite']
      other.textContent = ''
      /* A changed text is what makes a live region speak, so a repeat gets a trailing no-break space. */
      target.textContent = target.textContent === text ? `${text}\u00a0` : text
    },
  }
}
