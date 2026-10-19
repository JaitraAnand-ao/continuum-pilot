import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

export const render = (element: ReactElement): string => renderToStaticMarkup(element)

/* The text a person reads: tags removed, entities decoded, whitespace collapsed. */
export function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/* How many times a pattern occurs in the markup. */
export function countOf(html: string, pattern: RegExp): number {
  return html.match(new RegExp(pattern.source, 'g'))?.length ?? 0
}
