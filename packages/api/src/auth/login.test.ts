import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertHonoursContract } from '../test-support/contract.js'
import { cookieFrom, createHarness, PUBLIC_ORIGIN, type Harness } from '../test-support/harness.js'

let h: Harness
beforeEach(async () => {
  h = await createHarness()
})
afterEach(async () => {
  await h.close()
})

describe('IF-1 GET /auth/login', () => {
  it('redirects to the Keycloak authorization endpoint with PKCE S256, state, nonce and the Microsoft hint', async () => {
    const { response, location } = await h.startLogin()
    expect(response.statusCode).toBe(302)
    assertHonoursContract('IF-1', '/auth/login', response)
    expect(`${location.origin}${location.pathname}`).toBe(`${h.kc.issuer}/protocol/openid-connect/auth`)
    const params = location.searchParams
    expect(params.get('response_type')).toBe('code')
    expect(params.get('client_id')).toBe(h.kc.clientId)
    expect(params.get('redirect_uri')).toBe(`${PUBLIC_ORIGIN}/auth/callback`)
    expect(params.get('scope')).toBe('openid profile')
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(params.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(params.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(params.get('kc_idp_hint')).toBe('microsoft')
    expect(params.has('max_age')).toBe(false)
  })

  it('sets the 5-minute __Host-sr_login transaction cookie: httpOnly, Secure, SameSite=Lax, opaque', async () => {
    const { response, location, loginCookie } = await h.startLogin()
    const cookie = cookieFrom(response, '__Host-sr_login') as string
    expect(cookie).toMatch(/; Path=\/(;|$)/)
    expect(cookie).toMatch(/; Max-Age=300(;|$)/)
    expect(cookie).toMatch(/; HttpOnly(;|$)/)
    expect(cookie).toMatch(/; Secure(;|$)/)
    expect(cookie).toMatch(/; SameSite=Lax(;|$)/)
    expect(cookie).not.toMatch(/Domain=/i)
    /* the verifier, state and nonce are sealed, not readable in the cookie */
    expect(loginCookie).not.toContain(location.searchParams.get('state'))
    expect(loginCookie).not.toContain(location.searchParams.get('nonce'))
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('uses a fresh state, nonce and verifier on every attempt', async () => {
    const first = await h.startLogin()
    const second = await h.startLogin()
    for (const name of ['state', 'nonce', 'code_challenge']) {
      expect(second.location.searchParams.get(name)).not.toBe(first.location.searchParams.get(name))
    }
  })

  it('passes maxAge through as max_age, including 0 to force a fresh Microsoft sign-in', async () => {
    expect((await h.startLogin('?maxAge=0')).location.searchParams.get('max_age')).toBe('0')
    expect((await h.startLogin('?maxAge=900')).location.searchParams.get('max_age')).toBe('900')
  })

  it.each([
    ['an absolute returnTo', '?returnTo=https://evil.example/'],
    ['a protocol-relative returnTo', '?returnTo=//evil.example/'],
    ['a backslash returnTo', '?returnTo=/%5Cevil.example'],
    ['a relative returnTo', '?returnTo=reports'],
    ['an over-long returnTo', `?returnTo=/${'a'.repeat(512)}`],
    ['a maxAge above 900', '?maxAge=901'],
    ['a negative maxAge', '?maxAge=-1'],
    ['a non-numeric maxAge', '?maxAge=soon'],
  ])('answers 400 problem+json for %s', async (_name, query) => {
    const response = await h.app.inject({ method: 'GET', url: `/auth/login${query}` })
    expect(response.statusCode).toBe(400)
    assertHonoursContract('IF-1', '/auth/login', response)
    expect(response.json()).toMatchObject({ type: '/problems/invalid-request', status: 400 })
    expect(cookieFrom(response, '__Host-sr_login')).toBeUndefined()
  })

  it('accepts a same-origin returnTo such as /approvals?resume=<id>', async () => {
    const { response } = await h.startLogin(`?returnTo=${encodeURIComponent('/approvals?resume=p-1')}`)
    expect(response.statusCode).toBe(302)
  })

  it('answers 503 problem+json when Keycloak discovery is unavailable', async () => {
    h.kc.discoveryDown = true
    const response = await h.app.inject({ method: 'GET', url: '/auth/login' })
    expect(response.statusCode).toBe(503)
    assertHonoursContract('IF-1', '/auth/login', response)
    expect(response.json()).toMatchObject({ type: '/problems/identity-provider-unavailable', status: 503 })
    expect(response.body).not.toContain('127.0.0.1')
  })

  it('carries the caller trace ID from traceparent into the problem', async () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
    const response = await h.app.inject({
      method: 'GET',
      url: '/auth/login?maxAge=soon',
      headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
    })
    expect(response.json().traceId).toBe(traceId)
  })
})
