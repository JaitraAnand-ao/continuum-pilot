/* AC-8 and the no-tokens-in-browser gate: the SPA never touches browser storage or readable cookies,
 * never calls Keycloak or Graph, and never sends an Authorization header. */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('.', import.meta.url))

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'testing' ? [] : sources(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

describe('Scenario: Tokens stay on the server (AC-8)', () => {
  const files = sources(root)

  it('no SPA source holds or sends a token, touches storage or calls Keycloak or Graph', () => {
    const forbidden: [string, RegExp][] = [
      ['localStorage', /localStorage/],
      ['sessionStorage', /sessionStorage/],
      ['document.cookie', /document\.cookie/],
      ['indexedDB', /indexedDB/],
      ['an Authorization header', /authorization/i],
      ['a token', /access_?token|refresh_?token|id_?token|bearer/i],
      ['Keycloak or Graph directly', /\/realms\/|graph\.microsoft|login\.microsoftonline/],
      ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/],
    ]
    /* The session flow must exist for the scan to prove anything. */
    expect(files.map((file) => file.slice(root.length))).toEqual(
      expect.arrayContaining(['api/client.ts', 'session/controller.ts', 'browser.ts', 'App.tsx']),
    )
    const findings = files.flatMap((file) => {
      const source = readFileSync(file, 'utf8')
      return forbidden.filter(([, pattern]) => pattern.test(source)).map(([what]) => `${file}: ${what}`)
    })
    expect(findings).toEqual([])
  })
})
