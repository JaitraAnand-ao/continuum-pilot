import { randomBytes } from 'node:crypto'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startFakeKeycloak, type FakeKeycloak } from '../test/fake-keycloak'
import { buildApp } from './app'
import { createMemoryAuditSink, type MemoryAuditSink } from './audit'
import { loadConfig } from './config'
import { open, sha256Hex } from './crypto'
import { createKeycloakClient } from './oidc'
import { ADMIN_APP_ROLE, READER_APP_ROLE } from './roles'
import { createMemorySessionStore, type MemorySessionStore } from './session-store'

const MINUTE = 60 * 1000
const start = new Date('2026-10-19T08:00:00.000Z')
const sessionKey = randomBytes(32)
const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
const traceparent = `00-${traceId}-00f067aa0ba902b7-01`
const yesterdaysReport = '/api/v1/reports/daily/2026-10-18'

let keycloak: FakeKeycloak
let app: FastifyInstance
let sessions: MemorySessionStore
let audit: MemoryAuditSink
let now: Date
let logs: string[]

const advance = (ms: number) => {
  now = new Date(now.getTime() + ms)
}

const setCookies = (response: LightMyRequestResponse): string[] => {
  const header = response.headers['set-cookie']
  if (header === undefined) return []
  return Array.isArray(header) ? header : [header]
}

const cookieValue = (response: LightMyRequestResponse, name: string) => {
  const line = setCookies(response).find((cookie) => cookie.startsWith(`${name}=`))
  return line?.slice(name.length + 1).split(';')[0]
}

const problemKeys = (response: LightMyRequestResponse) => Object.keys(response.json()).sort()

const login = async (query = '') => {
  const response = await app.inject({ method: 'GET', url: `/auth/login${query}` })
  const location = new URL(String(response.headers.location))
  return { response, location, loginCookie: cookieValue(response, '__Host-sr_login') ?? '' }
}

interface SignIn {
  appRoles?: string[]
  account?: string
  previousSession?: string
  returnTo?: string
}

const completeSignIn = async ({
  appRoles = [READER_APP_ROLE],
  account = 'm.duarte@contoso.com',
  previousSession,
  returnTo,
}: SignIn = {}) => {
  const { location, loginCookie } = await login(
    returnTo === undefined ? '' : `?returnTo=${encodeURIComponent(returnTo)}`,
  )
  const verifierIsHidden = !loginCookie.includes(location.searchParams.get('state') ?? '-')
  const seconds = Math.floor(now.getTime() / 1000)
  const code = keycloak.issueCode({
    challenge: location.searchParams.get('code_challenge') ?? '',
    claims: {
      iss: keycloak.issuer,
      aud: keycloak.clientId,
      sub: `sub-${account}`,
      iat: seconds,
      exp: seconds + 300,
      auth_time: seconds - 3,
      nonce: location.searchParams.get('nonce'),
      preferred_username: account,
      name: 'M. Duarte',
      roles: appRoles,
    },
  })
  const cookie = [`__Host-sr_login=${loginCookie}`]
  if (previousSession !== undefined) cookie.push(`__Host-sr_session=${previousSession}`)
  const response = await app.inject({
    method: 'GET',
    url: `/auth/callback?code=${code}&state=${location.searchParams.get('state')}`,
    headers: { cookie: cookie.join('; ') },
  })
  return { response, session: cookieValue(response, '__Host-sr_session') ?? '', verifierIsHidden }
}

const get = (url: string, session?: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'GET',
    url,
    headers: session === undefined ? headers : { ...headers, cookie: `__Host-sr_session=${session}` },
  })

const keepalive = (session: string) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/session/keepalive',
    headers: { cookie: `__Host-sr_session=${session}` },
  })

beforeAll(async () => {
  keycloak = await startFakeKeycloak()
})
afterAll(() => keycloak.close())

beforeEach(async () => {
  now = start
  logs = []
  keycloak.failDiscovery = false
  keycloak.failToken = false
  const config = loadConfig({
    SR_OIDC_ISSUER: keycloak.issuer,
    SR_OIDC_CLIENT_ID: keycloak.clientId,
    SR_OIDC_CLIENT_SECRET: keycloak.clientSecret,
    SR_PUBLIC_ORIGIN: 'https://reports.example.test',
    SR_SESSION_KEY: sessionKey.toString('base64'),
  })
  const clock = { now: () => now }
  sessions = createMemorySessionStore()
  audit = createMemoryAuditSink()
  app = buildApp({
    config,
    clock,
    oidc: createKeycloakClient({
      issuer: config.oidcIssuer,
      clientId: config.oidcClientId,
      clientSecret: config.oidcClientSecret,
      clock,
    }),
    sessions,
    audit,
    logStream: { write: (line: string) => logs.push(line) },
  })
  await app.ready()
})
afterEach(() => app.close())

describe('IF-1 GET /auth/login', () => {
  it('redirects to Keycloak with PKCE, state and nonce and sets the 5-minute Lax transaction cookie', async () => {
    const { response, location, loginCookie } = await login()
    expect(response.statusCode).toBe(302)
    expect(`${location.origin}${location.pathname}`).toBe(`${keycloak.issuer}/protocol/openid-connect/auth`)
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
    expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(location.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43,}$/)
    expect(location.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43,}$/)
    expect(location.searchParams.get('redirect_uri')).toBe('https://reports.example.test/auth/callback')
    expect(setCookies(response)).toEqual([
      `__Host-sr_login=${loginCookie}; Path=/; Max-Age=300; HttpOnly; Secure; SameSite=Lax`,
    ])
    expect(loginCookie).not.toContain(location.searchParams.get('state'))
  })

  it('passes maxAge through as max_age', async () => {
    const { location } = await login('?maxAge=0')
    expect(location.searchParams.get('max_age')).toBe('0')
  })

  it.each(['?returnTo=//evil.example/x', '?returnTo=https://evil.example/', '?returnTo=/%5Cevil', '?maxAge=901'])(
    'answers %s with a 400 problem',
    async (query) => {
      const response = await app.inject({ method: 'GET', url: `/auth/login${query}`, headers: { traceparent } })
      expect(response.statusCode).toBe(400)
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/)
      expect(response.json()).toEqual({
        type: '/problems/invalid-request',
        title: 'Invalid request',
        status: 400,
        traceId,
      })
    },
  )

  it('answers 503 when Keycloak discovery is unavailable', async () => {
    keycloak.failDiscovery = true
    const response = await app.inject({ method: 'GET', url: '/auth/login' })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ type: '/problems/identity-provider-unavailable', status: 503 })
    expect(problemKeys(response)).toEqual(['status', 'title', 'traceId', 'type'])
  })
})

describe('IF-2 GET /auth/callback', () => {
  it('AC-2: signs a reader in with only the Strict session cookie and clears the transaction cookie', async () => {
    const { response, session, verifierIsHidden } = await completeSignIn()
    expect(verifierIsHidden).toBe(true)
    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/')
    expect(setCookies(response).sort()).toEqual([
      '__Host-sr_login=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
      `__Host-sr_session=${session}; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Strict`,
    ])
    const me = await get('/api/v1/me', session)
    expect(me.statusCode).toBe(200)
    expect(me.headers['cache-control']).toBe('no-store')
    expect(me.json()).toEqual({
      account: 'm.duarte@contoso.com',
      displayName: 'M. Duarte',
      roles: ['reader'],
      authTime: '2026-10-19T07:59:57.000Z',
      idleExpiresAt: '2026-10-19T08:15:00.000Z',
      absoluteExpiresAt: '2026-10-19T16:00:00.000Z',
    })
  })

  it('returns to the same-origin returnTo path after sign-in', async () => {
    const { response } = await completeSignIn({ returnTo: '/reports/daily/2026-10-18' })
    expect(response.headers.location).toBe('/reports/daily/2026-10-18')
  })

  it('AC-8: no access or refresh token reaches the browser', async () => {
    const { response, session } = await completeSignIn()
    const me = await get('/api/v1/me', session)
    for (const visible of [JSON.stringify(response.headers), response.body, JSON.stringify(me.headers), me.body]) {
      expect(visible).not.toContain('kc-access-token-value')
      expect(visible).not.toContain('kc-refresh-token-value')
      expect(visible).not.toMatch(/eyJ[\w-]+\.eyJ/)
    }
  })

  it('AC-8: stores only the SHA-256 of the session ID and the GCM-sealed refresh token', async () => {
    const { session } = await completeSignIn()
    const rows = sessions.rows()
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.idHash).toBe(sha256Hex(session))
    expect(JSON.stringify(row)).not.toContain(session)
    expect(JSON.stringify(row)).not.toContain('kc-refresh-token-value')
    expect(open(sessionKey, row.refreshToken ?? '')).toBe('kc-refresh-token-value')
    expect(open(sessionKey, row.idToken)).toMatch(/^eyJ/)
  })

  it('rotates the session at login: a new ID is issued and the previous session ends', async () => {
    const first = await completeSignIn()
    const second = await completeSignIn({ previousSession: first.session })
    expect(second.session).not.toBe(first.session)
    expect((await get('/api/v1/me', first.session)).statusCode).toBe(401)
    expect((await get('/api/v1/me', second.session)).statusCode).toBe(200)
  })

  it('AC-3: a person holding both claims gets both roles', async () => {
    const { session } = await completeSignIn({ appRoles: [READER_APP_ROLE, ADMIN_APP_ROLE] })
    expect((await get('/api/v1/me', session)).json().roles).toEqual([
      'reader',
      'config.read',
      'config.write',
      'config.approve',
    ])
  })

  it('AC-6: a Microsoft error redirects to the failure screen with the Entra code, a reference and a UTC time', async () => {
    const { location, loginCookie } = await login()
    const response = await app.inject({
      method: 'GET',
      url: `/auth/callback?error=access_denied&error_description=${encodeURIComponent('AADSTS50126: Error validating credentials')}&state=${location.searchParams.get('state')}`,
      headers: { cookie: `__Host-sr_login=${loginCookie}` },
    })
    expect(response.statusCode).toBe(302)
    const target = new URL(String(response.headers.location), 'https://reports.example.test')
    expect(target.pathname).toBe('/signin/error')
    expect(target.searchParams.get('code')).toBe('AADSTS50126')
    expect(target.searchParams.get('ref')).toMatch(/^[0-9a-f-]{36}$/)
    expect(target.searchParams.get('at')).toBe('2026-10-19T08:00:00.000Z')
    expect(setCookies(response)).toEqual(['__Host-sr_login=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'])
    expect(sessions.rows()).toHaveLength(0)
  })

  it('AC-6: an error without an Entra code reports the OAuth error name', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/callback?error=temporarily_unavailable' })
    const target = new URL(String(response.headers.location), 'https://reports.example.test')
    expect(target.searchParams.get('code')).toBe('temporarily_unavailable')
    const odd = await app.inject({ method: 'GET', url: '/auth/callback?error=%3Cscript%3E' })
    expect(new URL(String(odd.headers.location), 'https://x.test').searchParams.get('code')).toBe('unknown_error')
  })

  it('AC-6: a failed token exchange also lands on the failure screen', async () => {
    keycloak.failToken = true
    const { response, session } = await completeSignIn()
    expect(session).toBe('')
    const target = new URL(String(response.headers.location), 'https://reports.example.test')
    expect(target.pathname).toBe('/signin/error')
    expect(target.searchParams.get('code')).toBe('token_exchange_failed')
  })

  it('rejects a tampered state', async () => {
    const { loginCookie } = await login()
    const response = await app.inject({
      method: 'GET',
      url: '/auth/callback?code=abc&state=tampered',
      headers: { cookie: `__Host-sr_login=${loginCookie}` },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ type: '/problems/invalid-login-transaction', status: 400 })
    expect(setCookies(response)).toEqual(['__Host-sr_login=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'])
  })

  it('rejects a missing, forged or expired transaction cookie', async () => {
    const { location, loginCookie } = await login()
    const state = location.searchParams.get('state')
    const url = `/auth/callback?code=abc&state=${state}`
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(400)
    const forged = await app.inject({ method: 'GET', url, headers: { cookie: '__Host-sr_login=forged' } })
    expect(forged.statusCode).toBe(400)
    advance(5 * MINUTE)
    const expired = await app.inject({ method: 'GET', url, headers: { cookie: `__Host-sr_login=${loginCookie}` } })
    expect(expired.statusCode).toBe(400)
  })

  it('accepts the transaction one millisecond before its 5 minutes are up', async () => {
    const { location, loginCookie } = await login()
    advance(5 * MINUTE - 1)
    const response = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=unknown&state=${location.searchParams.get('state')}`,
      headers: { cookie: `__Host-sr_login=${loginCookie}` },
    })
    expect(response.statusCode).toBe(302)
  })

  it('answers a callback with neither code nor error with a 400 problem', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/callback?state=x' })
    expect(response.statusCode).toBe(400)
    expect(problemKeys(response)).toEqual(['status', 'title', 'traceId', 'type'])
  })

  it('logs neither the code, the tokens nor the account', async () => {
    await completeSignIn()
    const written = logs.join('\n')
    expect(written.length).toBeGreaterThan(0)
    expect(written).not.toContain('code=')
    expect(written).not.toContain('kc-refresh-token-value')
    expect(written).not.toContain('m.duarte@contoso.com')
  })
})

describe('IF-4 GET /api/v1/me', () => {
  it('answers 401 problem without a session', async () => {
    const response = await get('/api/v1/me')
    expect(response.statusCode).toBe(401)
    expect(problemKeys(response)).toEqual(['status', 'title', 'traceId', 'type'])
    expect((await get('/api/v1/me', 'unknown-session')).statusCode).toBe(401)
  })

  it('AC-5: answers 403 naming the account to someone in neither group and records an access-denied event', async () => {
    const { session } = await completeSignIn({ appRoles: [], account: 'outsider@contoso.com' })
    const response = await get('/api/v1/me', session, { traceparent })
    expect(response.statusCode).toBe(403)
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/)
    expect(response.json()).toEqual({
      type: '/problems/no-access',
      title: "You don't have access. Signed in as outsider@contoso.com.",
      status: 403,
      traceId,
    })
    expect(audit.events).toEqual([
      {
        type: 'access.denied',
        account: 'outsider@contoso.com',
        method: 'GET',
        route: '/api/v1/me',
        traceId,
        at: start,
      },
    ])
  })

  it('lets a report administrator without the reader role read /me', async () => {
    const { session } = await completeSignIn({ appRoles: [ADMIN_APP_ROLE] })
    expect((await get('/api/v1/me', session)).statusCode).toBe(200)
  })
})

describe('AC-7 report endpoints', () => {
  it('answer 401 without a session', async () => {
    const response = await get(yesterdaysReport, undefined, { traceparent })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({
      type: '/problems/unauthenticated',
      title: 'Sign-in required',
      status: 401,
      traceId,
    })
  })

  it('answer 403 with only type, title, status and traceId to an administrator without the reader role', async () => {
    const { session } = await completeSignIn({ appRoles: [ADMIN_APP_ROLE], account: 'admin@contoso.com' })
    const response = await get(yesterdaysReport, session, { traceparent })
    expect(response.statusCode).toBe(403)
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/)
    expect(response.json()).toEqual({ type: '/problems/forbidden', title: 'Forbidden', status: 403, traceId })
    expect(audit.events).toMatchObject([
      { type: 'access.denied', account: 'admin@contoso.com', route: yesterdaysReport },
    ])
  })

  it('AC-5: return no report data to an account in neither group', async () => {
    const { session } = await completeSignIn({ appRoles: [] })
    const response = await get(`${yesterdaysReport}?x=1`, session)
    expect(response.statusCode).toBe(403)
    expect(problemKeys(response)).toEqual(['status', 'title', 'traceId', 'type'])
    expect(audit.events).toMatchObject([{ route: yesterdaysReport }])
  })

  it('let a reader past the gate', async () => {
    const { session } = await completeSignIn()
    expect((await get(yesterdaysReport, session)).statusCode).toBe(404)
    expect(audit.events).toEqual([])
  })

  it('make up a trace ID when none is propagated', async () => {
    expect((await get(yesterdaysReport)).json().traceId).toMatch(/^[0-9a-f]{32}$/)
    expect((await get(yesterdaysReport, undefined, { traceparent: 'garbage' })).json().traceId).toMatch(
      /^[0-9a-f]{32}$/,
    )
  })
})

describe('AC-9 session limits', () => {
  it('keeps the session one millisecond before 15 idle minutes and ends it at 15', async () => {
    const { session } = await completeSignIn()
    advance(15 * MINUTE - 1)
    expect((await get('/api/v1/me', session)).statusCode).toBe(200)
    advance(1)
    const response = await get('/api/v1/me', session)
    expect(response.statusCode).toBe(401)
    expect(setCookies(response)).toEqual(['__Host-sr_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict'])
    expect(sessions.rows()).toHaveLength(0)
  })

  it('reading /me does not count as activity, so polling cannot keep a session alive', async () => {
    const { session } = await completeSignIn()
    advance(10 * MINUTE)
    expect((await get('/api/v1/me', session)).json().idleExpiresAt).toBe('2026-10-19T08:15:00.000Z')
    advance(5 * MINUTE)
    expect((await get('/api/v1/me', session)).statusCode).toBe(401)
  })

  it("'Stay signed in' at 13 idle minutes restarts the idle limit", async () => {
    const { session } = await completeSignIn()
    advance(13 * MINUTE)
    const response = await keepalive(session)
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json().idleExpiresAt).toBe('2026-10-19T08:28:00.000Z')
    advance(14 * MINUTE)
    expect((await get('/api/v1/me', session)).statusCode).toBe(200)
  })

  it('any other authenticated request counts as activity', async () => {
    const { session } = await completeSignIn()
    advance(14 * MINUTE)
    await get(yesterdaysReport, session)
    advance(14 * MINUTE)
    expect((await get('/api/v1/me', session)).statusCode).toBe(200)
  })

  it('ends a session after 8 hours even when it stays active, and the old cookie is answered 401', async () => {
    const { session } = await completeSignIn()
    for (let elapsed = 0; elapsed < 8 * 60 - 10; elapsed += 10) {
      advance(10 * MINUTE)
      expect((await keepalive(session)).statusCode).toBe(200)
    }
    advance(9 * MINUTE + 59 * 1000 + 999)
    expect((await keepalive(session)).statusCode).toBe(200)
    advance(1)
    expect((await get(yesterdaysReport, session)).statusCode).toBe(401)
    expect((await get('/api/v1/me', session)).statusCode).toBe(401)
  })

  it('keepalive answers 401 without a session and 403 to someone without access', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/v1/session/keepalive' })).statusCode).toBe(401)
    const { session } = await completeSignIn({ appRoles: [], account: 'outsider@contoso.com' })
    expect((await keepalive(session)).json().title).toBe("You don't have access. Signed in as outsider@contoso.com.")
  })
})

describe('IF-3 POST /auth/logout', () => {
  it('ends the session, clears the cookie and ends the Keycloak session', async () => {
    const { session } = await completeSignIn()
    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: `__Host-sr_session=${session}` },
    })
    expect(response.statusCode).toBe(303)
    const target = new URL(String(response.headers.location))
    expect(`${target.origin}${target.pathname}`).toBe(`${keycloak.issuer}/protocol/openid-connect/logout`)
    expect(target.searchParams.get('id_token_hint')).toMatch(/^eyJ/)
    expect(target.searchParams.get('post_logout_redirect_uri')).toBe('https://reports.example.test/signin')
    expect(setCookies(response)).toEqual(['__Host-sr_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict'])
    expect((await get('/api/v1/me', session)).statusCode).toBe(401)
  })

  it('returns to the Sign in screen when there is no session', async () => {
    const response = await app.inject({ method: 'POST', url: '/auth/logout' })
    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toBe('/signin')
  })

  it('still ends the local session when Keycloak is unavailable', async () => {
    const { session } = await completeSignIn()
    keycloak.failDiscovery = true
    const fresh = buildAppWithFreshDiscovery()
    await fresh.ready()
    const response = await fresh.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: `__Host-sr_session=${session}` },
    })
    expect(response.headers.location).toBe('/signin')
    expect(sessions.rows()).toHaveLength(0)
    await fresh.close()
  })
})

function buildAppWithFreshDiscovery() {
  const clock = { now: () => now }
  const config = loadConfig({
    SR_OIDC_ISSUER: keycloak.issuer,
    SR_OIDC_CLIENT_ID: keycloak.clientId,
    SR_OIDC_CLIENT_SECRET: keycloak.clientSecret,
    SR_PUBLIC_ORIGIN: 'https://reports.example.test',
    SR_SESSION_KEY: sessionKey.toString('base64'),
  })
  return buildApp({
    config,
    clock,
    oidc: createKeycloakClient({
      issuer: config.oidcIssuer,
      clientId: config.oidcClientId,
      clientSecret: config.oidcClientSecret,
      clock,
    }),
    sessions,
    audit,
  })
}
