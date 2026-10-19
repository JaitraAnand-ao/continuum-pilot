import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/* AC-8 and the web-imports-boundary gate, checked on the source the bundle is built from. */
const root = fileURLToPath(new URL('../src', import.meta.url))
const files = (readdirSync(root, { recursive: true }) as string[])
  .filter((name) => /\.(ts|tsx)$/.test(name))
  .map((name) => ({ name, source: readFileSync(join(root, name), 'utf8') }))

/* Each check first proves it is reading the API client and the screens, so none passes on an empty package. */
function scanned() {
  const names = files.map(({ name }) => name.replaceAll('\\', '/'))
  expect(names).toEqual(expect.arrayContaining(['api/client.ts', 'App.tsx', 'screens/SignInScreen.tsx']))
  return files
}

describe('Scenario: Tokens stay on the server (AC-8)', () => {
  it('never touches browser storage or readable cookies', () => {
    for (const { name, source } of scanned()) {
      expect(source, name).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/)
    }
  })

  it('never calls Keycloak or Microsoft Graph directly', () => {
    for (const { name, source } of scanned()) {
      expect(source, name).not.toMatch(/realms\/|graph\.microsoft|login\.microsoftonline|Authorization/)
    }
  })
})

describe('web imports boundary', () => {
  it('imports only React, the shared packages and its own modules', () => {
    for (const { name, source } of scanned()) {
      const imports = [...source.matchAll(/from '([^']+)'|import '([^']+)'/g)].map((match) => match[1] ?? match[2]!)
      for (const target of imports) {
        expect(target, name).toMatch(/^(\.{1,2}\/|react$|react-dom\/client$|@signin-reports\/(ui|api-client)$)/)
      }
    }
  })

  it('renders no raw HTML and reads no environment variables', () => {
    for (const { name, source } of scanned()) {
      expect(source, name).not.toMatch(/dangerouslySetInnerHTML|process\.env|import\.meta\.env/)
    }
  })
})
