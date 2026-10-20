/* IF-1 GET /auth/login and IF-2 GET /auth/callback: the OIDC code flow with PKCE, state and nonce (ST-1 AC-2..AC-6, AC-8). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOGIN_COOKIE, SESSION_COOKIE } from '../src/app.js'
import { pkceChallenge } from '../src/security/crypto.js'
import { BOTH, OUTSIDER, READER } from './support/fake-keycloak.js'
import { cookieValue, createHarness, setCookies, signIn, startLogin, type Harness } from './support/harness.js'

let h: Harness
beforeEach(() => {
  h = createHarness()
})
afterEach(async () => {
  await h.app.close()
})

function cookieLine(response: Parameters<typeof setCookies>[0], name: string): string {
  return setCookies(response).find((line) => line.startsWith(`${name}=`)) ?? ''
}

describe('GET /auth/login', () => {
  it('redirects to Keycloak with PKCE, state, nonce and the Microsoft hint, and sets the 5-minute Lax transaction cookie', async () => {
    const { response, location, loginCookie } = await startLogin(h, '?returnTo=%2Freports%2Fdaily')
    expect(response.statusCode).toBe(302)
    const url = new URL(location)
    expect(url.href.startsWith(h.keycloak.discovery.authorization_endpoint)).toBe(true)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(url.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(url.searchParams.get('kc_idp_hint')).toBe('microsoft')
    expect(url.searchParams.get('redirect_uri')).toBe('https://reports.contoso.test/auth/callback')
    const line = cookieLine(response, LOGIN_COOKIE)
    expect(line).toMatch(/; HttpOnly/)
    expect(line).toMatch(/; Secure/)
    expect(line).toMatch(/; SameSite=Lax/)
    expect(line).toMatch(/; Max-Age=300/)
    expect(line).toMatch(/; Path=\//)
    expect(line).not.toMatch(/Domain=/i)
    /* The cookie is sealed: neither the state nor the verifier behind the challenge can be read from it. */
    expect(loginCookie).toBeDefined()
    expect(loginCookie).not.toContain(url.searchParams.get('state'))
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('passes maxAge through as max_age so ST-17 can force a fresh Microsoft sign-in', async () => {
    const { location } = await startLogin(h, '?maxAge=0')
    expect(new URL(location).searchParams.get('max_age')).toBe('0')
    const { location: other } = await startLogin(h, '?maxAge=900')
    expect(new URL(other).searchParams.get('max_age')).toBe('900')
  })

  it.each([
    ['an absolute URL', '?returnTo=https%3A%2F%2Fevil.test%2F'],
    ['a protocol-relative URL', '?returnTo=%2F%2Fevil.test'],
    ['a backslash trick', '?returnTo=%2F%5Cevil.test'],
    ['a relative path', '?returnTo=reports'],
    ['a path over 512 characters', `?returnTo=%2F${'a'.repeat(512)}`],
    ['maxAge above 900', '?maxAge=901'],
    ['a negative maxAge', '?maxAge=-1'],
    ['a fractional maxAge', '?maxAge=1.5'],
  ])('refuses %s with 400 problem+json', async (_, query) => {
    const { response } = await startLogin(h, query)
    expect(response.statusCode).toBe(400)
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/)
    expect(Object.keys(response.json()).sort()).toEqual(['status', 'title', 'traceId', 'type'])
    expect(response.json()).toMatchObject({ type: '/problems/invalid-request', status: 400 })
    expect(setCookies(response)).toEqual([])
  })

  it('accepts returnTo at 512 characters', async () => {
    const { response } = await startLogin(h, `?returnTo=%2F${'a'.repeat(511)}`)
    expect(response.statusCode).toBe(302)
  })

  it('answers 503 problem+json when Keycloak discovery is unavailable', async () => {
    h.keycloak.state.discoveryDown = true
    const { response } = await startLogin(h)
    expect(response.statusCode).toBe(503)
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/)
    expect(response.json()).toMatchObject({ type: '/problems/identity-provider-unavailable', status: 503 })
    expect(setCookies(response)).toEqual([])
  })
})

describe('GET /auth/callback', () => {
  it('signs a reader in: Strict httpOnly __Host- session cookie, transaction cookie deleted, back to the app root', async () => {
    const { callback, session } = await signIn(h, READER)
    expect(callback.statusCode).toBe(302)
    expect(callback.headers.location).toBe('/')
    const line = cookieLine(callback, SESSION_COOKIE)
    expect(line).toMatch(/; HttpOnly/)
    expect(line).toMatch(/; Secure/)
    expect(line).toMatch(/; SameSite=Strict/)
    expect(line).toMatch(/; Path=\//)
    expect(line).not.toMatch(/Domain=/i)
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(cookieLine(callback, LOGIN_COOKIE)).toMatch(/Max-Age=0/)
    expect(h.audit.events).toEqual([])
  })

  it('returns to the same-origin returnTo the login started with', async () => {
    const login = await startLogin(h, '?returnTo=%2Fapprovals%3Fresume%3Dp-1')
    const { code, state } = h.keycloak.authorize(login.location, BOTH)
    const callback = await h.app.inject({
      method: 'GET',
      url: `/auth/callback?code=${code}&state=${state}`,
      cookies: { [LOGIN_COOKIE]: login.loginCookie! },
    })
    expect(callback.headers.location).toBe('/approvals?resume=p-1')
  })

  it('never hands a token to the browser: not in a header, a cookie or the body (AC-8)', async () => {
    const { login, callback } = await signIn(h, READER)
    expect(h.keycloak.state.issuedTokens).toHaveLength(3)
    const exposed = JSON.stringify([login.response.headers, login.response.body, callback.headers, callback.body])
    for (const token of h.keycloak.state.issuedTokens) expect(exposed).not.toContain(token)
  })

  it('stores only the SHA-256 of the session ID and the GCM ciphertext of the refresh token', async () => {
    const { session } = await signIn(h, READER)
    const rows = h.sessions.rows()
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    const stored = JSON.stringify(row)
    expect(stored).not.toContain(session)
    expect(row.idHash).toMatch(/^[0-9a-f]{64}$/)
    const refreshToken = h.keycloak.state.issuedTokens[2]!
    expect(stored).not.toContain(refreshToken)
    for (const token of h.keycloak.state.issuedTokens) expect(stored).not.toContain(token)
    expect(row.refreshTokenSealed).toBeTruthy()
    expect(row).toMatchObject({ account: READER.upn, displayName: READER.name, roles: ['reader'] })
  })

  it('rotates the session at login: a session cookie held before signing in stops working', async () => {
    const first = await signIn(h, READER)
    const second = await signIn(h, READER, { existingSession: first.session! })
    expect(second.session).not.toBe(first.session)
    expect(h.sessions.rows()).toHaveLength(1)
    const reuse = await h.app.inject({ url: '/api/v1/me', cookies: { [SESSION_COOKIE]: first.session! } })
    expect(reuse.statusCode).toBe(401)
  })

  it('signs in an account in neither group but records an access-denied audit event for it (AC-5)', async () => {
    const { callback, session } = await signIn(h, OUTSIDER)
    expect(callback.statusCode).toBe(302)
    expect(session).toBeDefined()
    expect(h.audit.events).toEqual([
      expect.objectContaining({
        type: 'access-denied',
        account: OUTSIDER.upn,
        reason: 'no-role',
        route: '/auth/callback',
        at: '2026-10-19T08:00:00.000Z',
      }),
    ])
    expect(h.audit.events[0]!.traceId).toMatch(/^[0-9a-f]{32}$/)
  })

  it('sends a Microsoft error to the Sign in screen with the Entra code, a reference and a UTC time (AC-6)', async () => {
    const login = await startLogin(h)
    const state = new URL(login.location).searchParams.get('state')!
    const callback = await h.app.inject({
      method: 'GET',
      url: `/auth/callback?error=access_denied&error_description=${encodeURIComponent('AADSTS50126: Error validating credentials due to invalid username or password.')}&state=${state}`,
      cookies: { [LOGIN_COOKIE]: login.loginCookie! },
    })
    expect(callback.statusCode).toBe(302)
    const target = new URL(String(callback.headers.location), 'https://reports.contoso.test')
    expect(target.pathname).toBe('/signin')
    expect(target.searchParams.get('error')).toBe('AADSTS50126')
    expect(target.searchParams.get('ref')).toMatch(/^[0-9a-f]{32}$/)
    expect(target.searchParams.get('at')).toBe('2026-10-19T08:00:00.000Z')
    expect(cookieValue(callback, SESSION_COOKIE)).toBeUndefined()
    expect(cookieLine(callback, LOGIN_COOKIE)).toMatch(/Max-Age=0/)
    expect(h.keycloak.state.tokenRequests).toBe(0)
  })

  it('uses the OIDC error itself when Microsoft gives no AADSTS code, and drops unsafe characters', async () => {
    const callback = await h.app.inject({ method: 'GET', url: '/auth/callback?error=temporarily_unavailable' })
    const target = new URL(String(callback.headers.location), 'https://x.test')
    expect(target.searchParams.get('error')).toBe('temporarily_unavailable')
    const odd = await h.app.inject({ method: 'GET', url: `/auth/callback?error=${encodeURIComponent('<script>')}` })
    expect(new URL(String(odd.headers.location), 'https://x.test').searchParams.get('error')).toBe('script')
    const empty = await h.app.inject({ method: 'GET', url: `/auth/callback?error=${encodeURIComponent('<>')}` })
    expect(new URL(String(empty.headers.location), 'https://x.test').searchParams.get('error')).toBe('unknown_error')
  })

  it('rejects a tampered state without calling Keycloak or creating a session', async () => {
    const login = await startLogin(h)
    const { code } = h.keycloak.authorize(login.location, READER)
    const callback = await h.app.inject({
      method: 'GET',
      url: `/auth/callback?code=${code}&state=forged-state`,
      cookies: { [LOGIN_COOKIE]: login.loginCookie! },
    })
    expectRejected(callback, 'invalid_state')
  })

  it('rejects a callback without its transaction cookie, or with a forged one', async () => {
    const login = await startLogin(h)
    const { code, state } = h.keycloak.authorize(login.location, READER)
    const missing = await h.app.inject({ method: 'GET', url: `/auth/callback?code=${code}&state=${state}` })
    expectRejected(missing, 'invalid_state')
    const forged = await h.app.inject({
      method: 'GET',
      url: `/auth/callback?code=${code}&state=${state}`,
      cookies: { [LOGIN_COOKIE]: `${login.loginCookie!.slice(0, -4)}AAAA` },
    })
    expectRejected(forged, 'invalid_state')
    const noCode = await h.app.inject({
      method: 'GET',
      url: `/auth/callback?state=${state}`,
      cookies: { [LOGIN_COOKIE]: login.loginCookie! },
    })
    expectRejected(noCode, 'invalid_state')
  })

  it('accepts the transaction one millisecond before 5 minutes and rejects it at 5 minutes', async () => {
    const early = await startLogin(h)
    const late = await startLogin(h)
    h.clock.advance(300_000 - 1)
    const ok = h.keycloak.authorize(early.location, READER)
    const accepted = await h.app.inject({
      method: 'GET',
      url: `/auth/callback?code=${ok.code}&state=${ok.state}`,
      cookies: { [LOGIN_COOKIE]: early.loginCookie! },
    })
    expect(cookieValue(accepted, SESSION_COOKIE)).toBeDefined()
    h.clock.advance(1)
    const expired = h.keycloak.authorize(late.location, READER)
    const refused = await h.app.inject({
      method: 'GET',
      url: `/auth/callback?code=${expired.code}&state=${expired.state}`,
      cookies: { [LOGIN_COOKIE]: late.loginCookie! },
    })
    expectRejected(refused, 'invalid_state', 1)
  })

  it('rejects an ID token carrying another nonce', async () => {
    h.keycloak.state.idTokenOverrides = { nonce: 'replayed-nonce' }
    const { callback } = await signIn(h, READER)
    expectRejected(callback, 'token_rejected', 1)
  })

  it('rejects the code when the PKCE verifier does not match the challenge Keycloak saw', async () => {
    const login = await startLogin(h)
    const { code, state } = h.keycloak.authorize(
      login.location.replace(/code_challenge=[^&]+/, `code_challenge=${pkceChallenge('another-verifier')}`),
      READER,
    )
    const callback = await h.app.inject({
      method: 'GET',
      url: `/auth/callback?code=${code}&state=${state}`,
      cookies: { [LOGIN_COOKIE]: login.loginCookie! },
    })
    expectRejected(callback, 'token_rejected', 1)
  })

  it('reports Keycloak being down at the token step as a failed sign-in', async () => {
    h.keycloak.state.tokenEndpointDown = true
    const { callback } = await signIn(h, READER)
    expectRejected(callback, 'idp_unavailable', 1)
  })
})

function expectRejected(response: Parameters<typeof setCookies>[0], code: string, tokenRequests = 0) {
  expect(response.statusCode).toBe(302)
  const target = new URL(String(response.headers.location), 'https://reports.contoso.test')
  expect(target.pathname).toBe('/signin')
  expect(target.searchParams.get('error')).toBe(code)
  expect(target.searchParams.get('ref')).toMatch(/^[0-9a-f]{32}$/)
  expect(cookieValue(response, SESSION_COOKIE)).toBeUndefined()
  expect(h.keycloak.state.tokenRequests).toBe(tokenRequests)
  expect(h.sessions.rows().filter((row) => row.account === READER.upn).length).toBeLessThanOrEqual(1)
}
