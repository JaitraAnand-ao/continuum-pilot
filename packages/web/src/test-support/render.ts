/* Test support: renders a React element to static markup and exposes it as text and as
 * elements, so component tests can assert exact copy, roles and ids without a browser. */
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const decode = (text: string) =>
  text
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

export function render(element: ReactElement) {
  const html = renderToStaticMarkup(element)
  const text = decode(
    html
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
  /** The opening tags of every element of the given tag name. */
  const tags = (name: string) => html.match(new RegExp(`<${name}\\b[^>]*>`, 'g')) ?? []
  /** The text inside every element of the given tag name (no nesting of the same tag). */
  const texts = (name: string) =>
    [...html.matchAll(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'g'))].map((match) =>
      decode(
        (match[1] ?? '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
      ),
    )
  /** The opening tag of the element carrying this id. */
  const byId = (id: string) => html.match(new RegExp(`<[a-z0-9]+\\b[^>]*\\bid="${id}"[^>]*>`))?.[0]
  return { html, text, tags, texts, byId }
}
