/* createServer wires the BFF from the SR_ environment against the real Keycloak adapter. */
import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InMemoryAuditSink, InMemorySessionStore, createServer } from '../src/index.js'
import { CLIENT_ID, CLIENT_SECRET, FakeKeycloak } from './support/fake-keycloak.js'
import { cookieValue, setCookies } from './support/harness.js'

let keycloak: FakeKeycloak

beforeEach(async () => {
  keycloak = await new FakeKeycloak().start()
})
afterEach(async () => {
  await keycloak.stop()
})

describe('createServer', () => {
  it('starts a sign-in against the configured realm and signs a reader in end to end', async () => {
    const sessions = new InMemorySessionStore()
    const app = createServer(
      {
        SR_PUBLIC_ORIGIN: 'https://reports.contoso.test',
        SR_OIDC_ISSUER: keycloak.issuer,
        SR_OIDC_CLIENT_ID: CLIENT_ID,
        SR_OIDC_CLIENT_SECRET: CLIENT_SECRET,
        SR_SESSION_KEY: randomBytes(32).toString('base64'),
      },
      { sessions, audit: new InMemoryAuditSink() },
    )
    const login = await app.inject({ url: '/auth/login' })
    expect(login.statusCode).toBe(302)
    const location = new URL(String(login.headers.location))
    expect(location.searchParams.get('redirect_uri')).toBe('https://reports.contoso.test/auth/callback')

    const { code, state } = keycloak.issueCode(String(login.headers.location), {
      preferred_username: 'm.duarte@contoso.com',
      roles: ['reader'],
    })
    const callback = await app.inject({
      url: `/auth/callback?code=${code}&state=${state}`,
      headers: { cookie: `__Host-sr_login=${cookieValue(setCookies(login.headers), '__Host-sr_login')}` },
    })
    expect(callback.statusCode).toBe(302)
    expect(sessions.rows.size).toBe(1)
    await app.close()
  })
})
