/* Scenario: Tokens stay on the server (AC-8). The SPA's only credential is the
 * httpOnly '__Host-sr_session' cookie the browser sends on its own: no source file may
 * read or write web storage or cookies, call Keycloak or Graph, or inject raw HTML. */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = new URL('.', import.meta.url).pathname
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'test-support' ? [] : sources(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })

describe('Scenario: Tokens stay on the server', () => {
  const files = sources(root)

  it('scans the application source', () => {
    expect(files.map((file) => relative(root, file))).toEqual(
      expect.arrayContaining(['api/client.ts', 'app/controller.ts', 'main.tsx']),
    )
  })

  it.each([
    ['web storage', /\b(localStorage|sessionStorage|indexedDB)\b/],
    ['JS-readable cookies', /document\.cookie/],
    ['tokens', /\b(access_?token|refresh_?token|id_?token|Authorization)\b/i],
    ['Keycloak or Graph', /realms\/|graph\.microsoft|login\.microsoftonline/],
    ['raw HTML', /dangerouslySetInnerHTML|innerHTML/],
    ['non-public environment variables', /import\.meta\.env\.(?!VITE_PUBLIC_)/],
  ])('no source file touches %s', (_name, pattern) => {
    expect(files).toContain(join(root, 'api/client.ts'))
    expect(
      files.filter((file) => pattern.test(readFileSync(file, 'utf8'))).map((file) => relative(root, file)),
    ).toEqual([])
  })

  it('every request sends credentials to the same origin only', () => {
    const client = readFileSync(join(root, 'api/client.ts'), 'utf8')
    expect(client).not.toMatch(/credentials:\s*'include'/)
    expect(client.match(/credentials:\s*'same-origin'/g)).toHaveLength(2)
  })
})
