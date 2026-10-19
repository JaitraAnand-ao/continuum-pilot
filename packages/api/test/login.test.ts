/* IF-1 GET /auth/login: the OIDC authorization code flow with PKCE S256, state and nonce, kc_idp_hint to Microsoft. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadContract, parameterSchema, responseSchema, violations } from './support/contract.js'
import { cookieValue, ORIGIN, setCookies, startHarness, type Harness } from './support/harness.js'

const IF1 = loadContract('IF-1')
let harness: Harness

beforeEach(async () => {
  harness = await startHarness()
})
afterEach(async () => {
  await harness.close()
})

describe('GET /auth/login', () => {
  it('302s to the Keycloak authorization endpoint with PKCE S256, state, nonce and the Microsoft hint', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/auth/login' })
    expect(response.statusCode).toBe(302)
    const location = new URL(String(response.headers.location))
    expect(`${location.origin}${location.pathname}`).toBe(`${harness.keycloak.issuer}/protocol/openid-connect/auth`)
    const query = Object.fromEntries(location.searchParams)
    expect(query).toMatchObject({
      response_type: 'code',
      client_id: 'signin-reports-bff',
      redirect_uri: `${ORIGIN}/auth/callback`,
      scope: 'openid',
      code_challenge_method: 'S256',
      kc_idp_hint: 'microsoft',
    })
    expect(query.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(query.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(query.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(query.max_age).toBeUndefined()
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('sets the 5-minute __Host-sr_login transaction cookie: httpOnly, Secure, SameSite=Lax', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/auth/login' })
    const cookies = setCookies(response.headers)
    expect(cookies).toHaveLength(1)
    expect(cookies[0]).toMatch(/^__Host-sr_login=[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=300$/)
  })

  it('keeps the state, nonce and PKCE verifier out of the browser-readable cookie in clear', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/auth/login' })
    const location = new URL(String(response.headers.location))
    const sealed = cookieValue(setCookies(response.headers), '__Host-sr_login') ?? ''
    const decoded = Buffer.from(sealed, 'base64url').toString('latin1')
    expect(decoded).not.toContain(location.searchParams.get('state'))
    expect(decoded).not.toContain(location.searchParams.get('nonce'))
  })

  it('uses a fresh state, nonce and challenge for every sign-in', async () => {
    const first = new URL(String((await harness.app.inject({ url: '/auth/login' })).headers.location))
    const second = new URL(String((await harness.app.inject({ url: '/auth/login' })).headers.location))
    for (const name of ['state', 'nonce', 'code_challenge']) {
      expect(first.searchParams.get(name)).not.toBe(second.searchParams.get(name))
    }
  })

  it('passes maxAge through as max_age (0 forces a fresh Microsoft sign-in)', async () => {
    const response = await harness.app.inject({ url: '/auth/login?maxAge=0&returnTo=%2Fapprovals%3Fresume%3Dp-1' })
    expect(response.statusCode).toBe(302)
    expect(new URL(String(response.headers.location)).searchParams.get('max_age')).toBe('0')
  })

  it.each([
    ['an absolute returnTo', 'returnTo=https%3A%2F%2Fevil.test%2F'],
    ['a protocol-relative returnTo', 'returnTo=%2F%2Fevil.test'],
    ['a backslash returnTo', 'returnTo=%2F%5Cevil.test'],
    ['a returnTo longer than 512', `returnTo=%2F${'a'.repeat(512)}`],
    ['a maxAge above 900', 'maxAge=901'],
    ['a negative maxAge', 'maxAge=-1'],
    ['a non-integer maxAge', 'maxAge=1.5'],
    ['an unknown parameter', 'prompt=none'],
  ])('answers 400 problem+json for %s', async (_name, query) => {
    const response = await harness.app.inject({ url: `/auth/login?${query}` })
    expect(response.statusCode).toBe(400)
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/)
    expect(setCookies(response.headers)).toEqual([])
    const body = response.json()
    expect(body).toEqual({
      type: '/problems/invalid-request',
      title: expect.any(String),
      status: 400,
      traceId: expect.any(String),
    })
    expect(await violations(responseSchema(IF1, '/auth/login', 'get', 400, 'application/problem+json'), body)).toEqual(
      [],
    )
  })

  it('accepts the boundary values the contract allows', async () => {
    for (const query of ['maxAge=900', 'returnTo=%2F', `returnTo=%2F${'a'.repeat(511)}`]) {
      expect((await harness.app.inject({ url: `/auth/login?${query}` })).statusCode).toBe(302)
    }
  })

  it('validates against the same returnTo and maxAge rules as the contract', async () => {
    const returnTo = parameterSchema(IF1, '/auth/login', 'get', 'returnTo')
    expect(await violations(returnTo, '/daily')).toEqual([])
    expect(await violations(returnTo, '//evil.test')).not.toEqual([])
    const maxAge = parameterSchema(IF1, '/auth/login', 'get', 'maxAge')
    expect(await violations(maxAge, 900)).toEqual([])
    expect(await violations(maxAge, 901)).not.toEqual([])
  })

  it('answers 503 problem+json when Keycloak discovery is unavailable, and recovers once it is back', async () => {
    harness.keycloak.discoveryAvailable = false
    const response = await harness.app.inject({
      url: '/auth/login',
      headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
    })
    expect(response.statusCode).toBe(503)
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/)
    const body = response.json()
    expect(body).toEqual({
      type: '/problems/idp-unavailable',
      title: expect.any(String),
      status: 503,
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    })
    expect(await violations(responseSchema(IF1, '/auth/login', 'get', 503, 'application/problem+json'), body)).toEqual(
      [],
    )

    harness.keycloak.discoveryAvailable = true
    expect((await harness.app.inject({ url: '/auth/login' })).statusCode).toBe(302)
  })
})

describe('unknown routes and failures', () => {
  it('answers 404 problem+json with a fresh trace ID when no valid traceparent is sent', async () => {
    const response = await harness.app.inject({
      url: '/nowhere',
      headers: { traceparent: '00-' + '0'.repeat(32) + '-00f067aa0ba902b7-01' },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({
      type: '/problems/not-found',
      title: 'Not found.',
      status: 404,
      traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
    })
    expect(response.json().traceId).not.toBe('0'.repeat(32))
  })
})
