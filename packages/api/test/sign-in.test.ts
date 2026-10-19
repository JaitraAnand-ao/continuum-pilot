import { describe, expect, it, vi } from 'vitest'
import { unseal, sha256Hex } from '../src/crypto.js'
import { OidcRejectedError, OidcUnavailableError } from '../src/oidc.js'
import { expectHonours, loadContract } from './support/contract.js'
import { ORIGIN, cookieValue, harness, setCookies, signIn } from './support/harness.js'

/* Building the first Fastify instance of a run is slow on a cold CI worker. */
vi.setConfig({ testTimeout: 30_000 })

const IF1 = loadContract('IF-1')

async function startLogin(h: ReturnType<typeof harness>, query = '') {
  const response = await h.app.inject({ method: 'GET', url: `/auth/login${query}` })
  const cookies = setCookies(response.headers)
  return {
    response,
    cookies,
    loginCookie: cookieValue(cookies, '__Host-sr_login') as string,
    state: new URL(String(response.headers.location)).searchParams.get('state') as string,
  }
}

describe('IF-1 GET /auth/login', () => {
  it('redirects to Keycloak with PKCE S256, state and nonce, and sets the 5-minute Lax transaction cookie', async () => {
    const h = harness()
    const { response, cookies } = await startLogin(h, '?returnTo=%2Fapprovals%3Fresume%3Dp-1&maxAge=0')
    expectHonours(IF1, '/auth/login', 'get', response)
    expect(response.statusCode).toBe(302)
    const [request] = h.oidc.authorizations
    expect(request?.redirectUri).toBe(`${ORIGIN}/auth/callback`)
    expect(request?.maxAge).toBe(0)
    expect(request?.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(request?.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(request?.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(cookies).toHaveLength(1)
    expect(cookies[0]).toMatch(/^__Host-sr_login=v1\.[^;]+; Path=\/; Max-Age=300; HttpOnly; Secure; SameSite=Lax$/)
    /* The transaction cookie is sealed: neither the verifier nor the state reads in clear. */
    expect(cookies[0]).not.toContain(request?.state)
    const transaction = JSON.parse(unseal(cookieValue(cookies, '__Host-sr_login') as string, h.sealingKey))
    expect(transaction.returnTo).toBe('/approvals?resume=p-1')
    expect(request?.codeChallenge).not.toBe(transaction.verifier)
  })

  it('draws a fresh state, nonce and verifier on every sign-in', async () => {
    const h = harness()
    await startLogin(h)
    await startLogin(h)
    const [first, second] = h.oidc.authorizations
    expect(first?.state).not.toBe(second?.state)
    expect(first?.nonce).not.toBe(second?.nonce)
    expect(first?.codeChallenge).not.toBe(second?.codeChallenge)
    expect(first?.maxAge).toBeUndefined()
  })

  it.each([
    ['an absolute returnTo', '?returnTo=https%3A%2F%2Fevil.test%2F'],
    ['a protocol-relative returnTo', '?returnTo=%2F%2Fevil.test'],
    ['a backslash returnTo', '?returnTo=%2F%5Cevil.test'],
    ['an over-long returnTo', `?returnTo=%2F${'a'.repeat(512)}`],
    ['maxAge above 900', '?maxAge=901'],
    ['a negative maxAge', '?maxAge=-1'],
    ['a non-integer maxAge', '?maxAge=soon'],
  ])('answers 400 problem+json for %s', async (_, query) => {
    const h = harness()
    const response = await h.app.inject({ method: 'GET', url: `/auth/login${query}` })
    expect(response.statusCode).toBe(400)
    expectHonours(IF1, '/auth/login', 'get', response)
    expect(response.json().type).toBe('/problems/invalid-request')
    expect(h.oidc.authorizations).toHaveLength(0)
  })

  it('accepts the boundary values maxAge=900 and returnTo=/', async () => {
    const response = await harness().app.inject({ method: 'GET', url: '/auth/login?maxAge=900&returnTo=%2F' })
    expect(response.statusCode).toBe(302)
  })

  it('answers 503 problem+json without the upstream message when Keycloak discovery is unavailable', async () => {
    const h = harness()
    h.oidc.failAuthorization = new OidcUnavailableError('connect ECONNREFUSED 10.0.0.7:8443')
    const response = await h.app.inject({ method: 'GET', url: '/auth/login' })
    expect(response.statusCode).toBe(503)
    expectHonours(IF1, '/auth/login', 'get', response)
    expect(response.body).not.toContain('ECONNREFUSED')
    expect(response.headers['set-cookie']).toBeUndefined()
  })
})

describe('GET /auth/callback', () => {
  it('AC-2: exchanges the code with the transaction verifier and nonce, and returns to the requested page', async () => {
    const h = harness()
    const { loginCookie, state } = await startLogin(h, '?returnTo=%2Freports%2Fdaily')
    const response = await h.app.inject({
      method: 'GET',
      url: `/auth/callback?code=the-code&state=${state}`,
      headers: { cookie: `__Host-sr_login=${loginCookie}` },
    })
    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/reports/daily')
    const transaction = JSON.parse(unseal(loginCookie, h.sealingKey))
    expect(h.oidc.exchanges).toEqual([
      {
        code: 'the-code',
        codeVerifier: transaction.verifier,
        redirectUri: `${ORIGIN}/auth/callback`,
        nonce: transaction.nonce,
      },
    ])
    expect(h.audit.events.map((e) => e.type)).toEqual(['session.signed_in'])
  })

  it('AC-8: issues only the httpOnly, Secure, SameSite=Strict __Host-sr_session cookie and deletes the Lax one', async () => {
    const h = harness()
    const { loginCookie, state } = await startLogin(h)
    const response = await h.app.inject({
      method: 'GET',
      url: `/auth/callback?code=the-code&state=${state}`,
      headers: { cookie: `__Host-sr_login=${loginCookie}` },
    })
    const cookies = setCookies(response.headers)
    expect(cookies).toHaveLength(2)
    expect(cookies).toContain('__Host-sr_login=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax')
    const session = cookies.find((c) => c.startsWith('__Host-sr_session=')) as string
    expect(session).toMatch(
      /^__Host-sr_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=28800; HttpOnly; Secure; SameSite=Strict$/,
    )
    /* No token reaches the browser: not in a cookie, a header or the body. */
    const everything = JSON.stringify(response.headers) + response.body
    expect(everything).not.toContain('refresh-token-value')
    expect(response.body).toBe('')
  })

  it('AC-8: stores only the SHA-256 of the session ID and the AES-256-GCM ciphertext of the refresh token', async () => {
    const h = harness()
    const id = await signIn(h)
    const rows = [...h.sessions.rows.values()]
    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row?.idHash).toBe(sha256Hex(id))
    expect(JSON.stringify(row)).not.toContain(id)
    expect(row?.refreshTokenCiphertext).toMatch(/^v1\./)
    expect(JSON.stringify(row)).not.toContain('refresh-token-value')
    expect(unseal(row?.refreshTokenCiphertext as string, h.sealingKey)).toBe('refresh-token-value')
  })

  it('stores no ciphertext when Keycloak issues no refresh token', async () => {
    const h = harness()
    h.oidc.refreshToken = null
    await signIn(h)
    expect([...h.sessions.rows.values()][0]?.refreshTokenCiphertext).toBeNull()
  })

  it('rotates at login: a session presented with the callback is ended, and a new ID is issued', async () => {
    const h = harness()
    const old = await signIn(h)
    const { loginCookie, state } = await startLogin(h)
    const response = await h.app.inject({
      method: 'GET',
      url: `/auth/callback?code=c&state=${state}`,
      headers: { cookie: `__Host-sr_login=${loginCookie}; __Host-sr_session=${old}` },
    })
    const fresh = cookieValue(setCookies(response.headers), '__Host-sr_session')
    expect(fresh).toBeDefined()
    expect(fresh).not.toBe(old)
    expect(h.sessions.rows.has(sha256Hex(old))).toBe(false)
    expect(h.sessions.rows.size).toBe(1)
  })

  describe('refuses a tampered or stale login transaction', () => {
    async function expectRefused(h: ReturnType<typeof harness>, url: string, cookie?: string) {
      const response = await h.app.inject({ method: 'GET', url, headers: cookie === undefined ? {} : { cookie } })
      expect(response.statusCode).toBe(302)
      const location = new URL(String(response.headers.location), ORIGIN)
      expect(location.pathname).toBe('/signin')
      expect(location.searchParams.get('error')).toBe('invalid_state')
      expect(cookieValue(setCookies(response.headers), '__Host-sr_session')).toBeUndefined()
      expect(h.oidc.exchanges).toHaveLength(0)
      expect(h.sessions.rows.size).toBe(0)
      expect(h.audit.events.at(-1)).toMatchObject({ type: 'signin.failed', reason: 'invalid_state' })
    }

    it('a state that does not match the transaction', async () => {
      const h = harness()
      const { loginCookie } = await startLogin(h)
      await expectRefused(h, '/auth/callback?code=c&state=forged', `__Host-sr_login=${loginCookie}`)
    })

    it('a missing transaction cookie', async () => {
      const h = harness()
      const { state } = await startLogin(h)
      await expectRefused(h, `/auth/callback?code=c&state=${state}`)
    })

    it('a transaction cookie that was altered', async () => {
      const h = harness()
      const { loginCookie, state } = await startLogin(h)
      const altered = `${loginCookie.slice(0, -2)}${loginCookie.endsWith('AA') ? 'BB' : 'AA'}`
      await expectRefused(h, `/auth/callback?code=c&state=${state}`, `__Host-sr_login=${altered}`)
    })

    it('a transaction at its 5-minute limit, while one millisecond earlier is accepted', async () => {
      const h = harness()
      const { loginCookie, state } = await startLogin(h)
      h.clock.advance(300_000)
      await expectRefused(h, `/auth/callback?code=c&state=${state}`, `__Host-sr_login=${loginCookie}`)

      const h2 = harness()
      const second = await startLogin(h2)
      h2.clock.advance(299_999)
      const response = await h2.app.inject({
        method: 'GET',
        url: `/auth/callback?code=c&state=${second.state}`,
        headers: { cookie: `__Host-sr_login=${second.loginCookie}` },
      })
      expect(cookieValue(setCookies(response.headers), '__Host-sr_session')).toBeDefined()
    })

    it('a callback without a code', async () => {
      const h = harness()
      const { loginCookie, state } = await startLogin(h)
      await expectRefused(h, `/auth/callback?state=${state}`, `__Host-sr_login=${loginCookie}`)
    })

    it('a callback whose query fails validation', async () => {
      const h = harness()
      const { loginCookie, state } = await startLogin(h)
      await expectRefused(h, `/auth/callback?code=${'c'.repeat(4097)}&state=${state}`, `__Host-sr_login=${loginCookie}`)
    })
  })

  it('AC-6: a Microsoft error returns to the sign-in screen with the Entra code, a reference and a UTC timestamp', async () => {
    const h = harness()
    const { loginCookie } = await startLogin(h)
    const response = await h.app.inject({
      method: 'GET',
      url: `/auth/callback?error=access_denied&error_description=${encodeURIComponent('AADSTS50126: Error validating credentials due to invalid username or password.')}`,
      headers: {
        cookie: `__Host-sr_login=${loginCookie}`,
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      },
    })
    expect(response.statusCode).toBe(302)
    const location = new URL(String(response.headers.location), ORIGIN)
    expect(location.pathname).toBe('/signin')
    expect(Object.fromEntries(location.searchParams)).toEqual({
      error: 'AADSTS50126',
      ref: '4bf92f3577b34da6a3ce929d0e0e4736',
      at: '2026-10-19T08:00:00.000Z',
    })
    /* The description's free text, which can name the user, is not passed on. */
    expect(String(response.headers.location)).not.toContain('username')
    expect(setCookies(response.headers)).toEqual([
      '__Host-sr_login=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    ])
    expect(h.oidc.exchanges).toHaveLength(0)
    expect(h.audit.events).toEqual([
      { type: 'signin.failed', at: h.clock.now(), traceId: '4bf92f3577b34da6a3ce929d0e0e4736', reason: 'AADSTS50126' },
    ])
  })

  it('AC-6: falls back to the OAuth error code, and refuses to echo an unexpected one', async () => {
    const h = harness()
    const plain = await h.app.inject({ method: 'GET', url: '/auth/callback?error=temporarily_unavailable' })
    expect(new URL(String(plain.headers.location), ORIGIN).searchParams.get('error')).toBe('temporarily_unavailable')
    const odd = await h.app.inject({ method: 'GET', url: '/auth/callback?error=%3Cscript%3E' })
    expect(new URL(String(odd.headers.location), ORIGIN).searchParams.get('error')).toBe('invalid_request')
  })

  it.each([
    ['token_rejected', new OidcRejectedError('ID token nonce does not match')],
    ['idp_unavailable', new OidcUnavailableError('Keycloak is unreachable')],
  ])('answers %s when the exchange or token validation fails', async (code, error) => {
    const h = harness()
    h.oidc.failSignIn = error
    const { loginCookie, state } = await startLogin(h)
    const response = await h.app.inject({
      method: 'GET',
      url: `/auth/callback?code=c&state=${state}`,
      headers: { cookie: `__Host-sr_login=${loginCookie}` },
    })
    expect(new URL(String(response.headers.location), ORIGIN).searchParams.get('error')).toBe(code)
    expect(cookieValue(setCookies(response.headers), '__Host-sr_session')).toBeUndefined()
    expect(h.sessions.rows.size).toBe(0)
  })
})
