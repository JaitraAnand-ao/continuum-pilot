import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hashSessionId, openToken, deriveKey } from '../session/crypto.js'
import {
  cookieFrom,
  cookieValue,
  createHarness,
  OUTSIDER,
  READER,
  READER_AND_ADMIN,
  SIGNED_IN_AT,
  type Harness,
} from '../test-support/harness.js'

let h: Harness
beforeEach(async () => {
  h = await createHarness()
})
afterEach(async () => {
  await h.close()
})

function expectFailureRedirect(response: { statusCode: number; headers: Record<string, unknown> }, code: string) {
  expect(response.statusCode).toBe(302)
  const location = new URL(response.headers.location as string, 'https://reports.example.test')
  expect(location.pathname).toBe('/signin/failed')
  expect(location.searchParams.get('code')).toBe(code)
  expect(location.searchParams.get('ref')).toMatch(/^[0-9a-f]{32}$/)
  expect(location.searchParams.get('at')).toBe(h.clock.now().toISOString())
  expect(cookieFrom(response as never, '__Host-sr_session')).toBeUndefined()
  expect(cookieFrom(response as never, '__Host-sr_login')).toMatch(/^__Host-sr_login=; .*Max-Age=0/)
}

describe('AC-2 and AC-8 GET /auth/callback for a reader', () => {
  it('exchanges the code with the PKCE verifier and lands on the requested page', async () => {
    const start = await h.startLogin(`?returnTo=${encodeURIComponent('/reports/daily')}`)
    const response = await h.completeLogin(start, READER)
    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/reports/daily')
    const tokenRequest = h.kc.tokenRequests.at(-1) as Record<string, string>
    expect(tokenRequest.grant_type).toBe('authorization_code')
    expect(
      createHash('sha256')
        .update(tokenRequest.code_verifier as string)
        .digest('base64url'),
    ).toBe(start.location.searchParams.get('code_challenge'))
  })

  it('lands on / when no returnTo was asked for', async () => {
    const response = await h.completeLogin(await h.startLogin(), READER)
    expect(response.headers.location).toBe('/')
  })

  it('issues only the __Host-sr_session cookie: httpOnly, Secure, SameSite=Strict, Path=/', async () => {
    const response = await h.completeLogin(await h.startLogin(), READER)
    const cookie = cookieFrom(response, '__Host-sr_session') as string
    expect(cookie).toMatch(/^__Host-sr_session=[A-Za-z0-9_-]{43}; /)
    expect(cookie).toMatch(/; Path=\/(;|$)/)
    expect(cookie).toMatch(/; HttpOnly(;|$)/)
    expect(cookie).toMatch(/; Secure(;|$)/)
    expect(cookie).toMatch(/; SameSite=Strict(;|$)/)
    expect(cookie).not.toMatch(/Domain=/i)
    expect(cookieFrom(response, '__Host-sr_login')).toMatch(/^__Host-sr_login=; .*Max-Age=0/)
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('never hands an access, refresh or ID token to the browser', async () => {
    const response = await h.completeLogin(await h.startLogin(), READER)
    const everything = `${JSON.stringify(response.headers)}${response.body}`
    expect(everything).not.toContain(h.kc.refreshTokens.at(-1))
    expect(everything).not.toMatch(/at-[0-9a-f]{48}/)
    expect(everything).not.toMatch(/eyJ[A-Za-z0-9_-]+\./)
  })

  it('stores only the SHA-256 of the session ID and the refresh token as AES-256-GCM ciphertext', async () => {
    const response = await h.completeLogin(await h.startLogin(), READER)
    const sessionId = cookieValue(cookieFrom(response, '__Host-sr_session'))
    const [row] = h.sessions.rows()
    expect(h.sessions.rows()).toHaveLength(1)
    expect(row?.idHash).toBe(hashSessionId(sessionId))
    expect(JSON.stringify(row)).not.toContain(sessionId)
    const refreshToken = h.kc.refreshTokens.at(-1) as string
    expect(JSON.stringify(row)).not.toContain(refreshToken)
    const key = deriveKey(h.config.sessionKey.reveal(), 'refresh-token')
    expect(openToken(key, row?.refreshTokenCiphertext as string, 'refresh-token')).toBe(refreshToken)
    expect(row).toMatchObject({
      account: READER.upn,
      displayName: READER.name,
      roles: ['reader'],
      authTime: SIGNED_IN_AT,
      createdAt: SIGNED_IN_AT,
      lastSeenAt: SIGNED_IN_AT,
    })
  })

  it('rotates the session at login: a session cookie already held is ended', async () => {
    const old = await h.signIn(READER)
    const response = await h.completeLogin(await h.startLogin(), READER_AND_ADMIN, {
      extraCookie: `__Host-sr_session=${old}`,
    })
    const fresh = cookieValue(cookieFrom(response, '__Host-sr_session'))
    expect(fresh).not.toBe(old)
    expect(h.sessions.rows().map((row) => row.idHash)).toEqual([hashSessionId(fresh)])
  })

  it('falls back to preferred_username and the account when upn or name are absent', async () => {
    await h.signIn({ preferred_username: 'p.pref@contoso.com', roles: ['reader'] })
    expect(h.sessions.rows()[0]).toMatchObject({ account: 'p.pref@contoso.com', displayName: 'p.pref@contoso.com' })
  })
})

describe('AC-5 GET /auth/callback for an account in neither group', () => {
  it('signs the account in so it can be told who it is, and records an access-denied audit event', async () => {
    const response = await h.completeLogin(await h.startLogin(), OUTSIDER)
    expect(response.statusCode).toBe(302)
    expect(cookieFrom(response, '__Host-sr_session')).toBeDefined()
    expect(h.sessions.rows()[0]?.roles).toEqual([])
    expect(h.audit.events).toEqual([
      expect.objectContaining({
        type: 'access-denied',
        account: OUTSIDER.upn,
        route: '/auth/callback',
        method: 'GET',
        at: SIGNED_IN_AT,
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
      }),
    ])
  })
})

describe('AC-6 GET /auth/callback when sign-in does not complete', () => {
  it('hands the Entra error code, an error reference and a UTC timestamp to the failure screen', async () => {
    const start = await h.startLogin()
    const state = start.location.searchParams.get('state') as string
    const description = 'AADSTS50126: Error validating credentials due to invalid username or password.'
    const response = await h.app.inject({
      method: 'GET',
      url: `/auth/callback?error=access_denied&error_description=${encodeURIComponent(description)}&state=${state}`,
      headers: { cookie: `__Host-sr_login=${start.loginCookie}` },
    })
    expectFailureRedirect(response, 'AADSTS50126')
    expect(response.headers.location).not.toContain('username')
    expect(h.kc.tokenRequests).toHaveLength(0)
  })

  it('falls back to the OAuth error when no Entra code is given, and to unknown_error for junk', async () => {
    const start = await h.startLogin()
    const plain = await h.app.inject({
      method: 'GET',
      url: '/auth/callback?error=temporarily_unavailable',
      headers: { cookie: `__Host-sr_login=${start.loginCookie}` },
    })
    expectFailureRedirect(plain, 'temporarily_unavailable')
    const junk = await h.app.inject({ method: 'GET', url: '/auth/callback?error=%3Cscript%3E' })
    expectFailureRedirect(junk, 'unknown_error')
  })

  it('rejects a tampered state', async () => {
    const response = await h.completeLogin(await h.startLogin(), READER, { state: 'x'.repeat(43) })
    expectFailureRedirect(response, 'state_mismatch')
    expect(h.kc.tokenRequests).toHaveLength(0)
  })

  it('rejects a callback without the login transaction cookie, or with a forged one', async () => {
    const start = await h.startLogin()
    const state = start.location.searchParams.get('state') as string
    const missing = await h.app.inject({ method: 'GET', url: `/auth/callback?code=c&state=${state}` })
    expectFailureRedirect(missing, 'login_expired')
    const forged = await h.app.inject({
      method: 'GET',
      url: `/auth/callback?code=c&state=${state}`,
      headers: { cookie: `__Host-sr_login=${start.loginCookie.slice(0, -4)}AAAA` },
    })
    expectFailureRedirect(forged, 'login_expired')
  })

  it('accepts the transaction at 300 seconds and rejects it one second later', async () => {
    const inTime = await h.startLogin()
    h.clock.advance(300_000)
    expect((await h.completeLogin(inTime, READER)).headers.location).toBe('/')
    const late = await h.startLogin()
    h.clock.advance(301_000)
    expectFailureRedirect(await h.completeLogin(late, READER), 'login_expired')
  })

  it('rejects a callback without a code', async () => {
    const start = await h.startLogin()
    const response = await h.app.inject({
      method: 'GET',
      url: `/auth/callback?state=${start.location.searchParams.get('state')}`,
      headers: { cookie: `__Host-sr_login=${start.loginCookie}` },
    })
    expectFailureRedirect(response, 'invalid_callback')
  })

  it('rejects a tampered PKCE verifier at the token endpoint', async () => {
    const response = await h.completeLogin(await h.startLogin(), READER, { codeVerifierChallenge: 'y'.repeat(43) })
    expectFailureRedirect(response, 'token_exchange_failed')
  })

  it('rejects a tampered nonce', async () => {
    const response = await h.completeLogin(await h.startLogin(), READER, { nonce: 'z'.repeat(43) })
    expectFailureRedirect(response, 'token_invalid')
  })

  it.each([
    ['signed by a key outside the JWKS', { rogue: true }],
    ['signed with alg none', { alg: 'none' }],
    ['from another issuer', { overrides: { iss: 'https://evil.example/realms/signin-reports' } }],
    ['for another audience', { overrides: { aud: 'another-client', azp: 'another-client' } }],
    ['already expired', { overrides: { exp: SIGNED_IN_AT.getTime() / 1000 - 31 } }],
    ['without auth_time', { overrides: { auth_time: undefined } }],
  ])('rejects an ID token %s', async (_name, tamper: { rogue?: boolean; alg?: string; overrides?: object }) => {
    h.kc.signWithRogueKey = tamper.rogue ?? false
    h.kc.idTokenAlg = tamper.alg ?? 'RS256'
    h.kc.idTokenOverrides = { ...tamper.overrides }
    expectFailureRedirect(await h.completeLogin(await h.startLogin(), READER), 'token_invalid')
  })

  it('accepts an audience array that names this client', async () => {
    h.kc.idTokenOverrides = { aud: ['account', h.kc.clientId] }
    expect((await h.completeLogin(await h.startLogin(), READER)).headers.location).toBe('/')
  })

  it('rejects an ID token older than the requested maxAge', async () => {
    h.kc.idTokenOverrides = { auth_time: SIGNED_IN_AT.getTime() / 1000 - 600 }
    expect((await h.completeLogin(await h.startLogin('?maxAge=900'), READER)).headers.location).toBe('/')
    expectFailureRedirect(await h.completeLogin(await h.startLogin('?maxAge=0'), READER), 'token_invalid')
  })

  it('reports the identity provider as unavailable when Keycloak cannot be reached', async () => {
    const start = await h.startLogin()
    h.kc.tokenEndpointDown = true
    expectFailureRedirect(await h.completeLogin(start, READER), 'identity_provider_unavailable')
  })
})
