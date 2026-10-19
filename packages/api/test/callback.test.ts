/* The sign-in callback (ST-1 AC-2, AC-5, AC-6, AC-8): state, nonce and PKCE are verified before a session exists;
 * the browser receives only the Strict session cookie, and the stored row holds only a hash and ciphertext. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { open, sha256Hex } from '../src/crypto.js'
import { headerSchema, loadContract, responseSchema, violations } from './support/contract.js'
import { OUTSIDER, READER, cookieValue, setCookies, signIn, startHarness, type Harness } from './support/harness.js'

const IF2 = loadContract('IF-2')
const refused = responseSchema(IF2, '/auth/callback', 'get', 400, 'application/problem+json')
const redirect = headerSchema(IF2, '/auth/callback', 'get', 302, 'Location')
let harness: Harness

beforeEach(async () => {
  harness = await startHarness()
})
afterEach(async () => {
  await harness.close()
})

async function startLogin(returnTo?: string) {
  const query = returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''
  const login = await harness.app.inject({ url: `/auth/login${query}` })
  const loginCookie = `__Host-sr_login=${cookieValue(setCookies(login.headers), '__Host-sr_login')}`
  return { location: String(login.headers.location), loginCookie }
}

const expectRefused = async (response: {
  statusCode: number
  headers: Record<string, unknown>
  json: () => unknown
}) => {
  expect(response.statusCode).toBe(400)
  expect(await violations(refused, response.json())).toEqual([])
  expect(response.json()).toEqual({
    type: '/problems/invalid-login-transaction',
    title: expect.any(String),
    status: 400,
    traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
  })
  const cookies = setCookies(response.headers)
  expect(cookies.some((cookie) => cookie.startsWith('__Host-sr_session=') && !cookie.includes('Max-Age=0'))).toBe(false)
  expect(cookies).toContain('__Host-sr_login=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0')
  expect(harness.sessions.rows.size).toBe(0)
}

describe('GET /auth/callback — success', () => {
  it('issues only the httpOnly, Secure, SameSite=Strict __Host-sr_session cookie and deletes the login cookie', async () => {
    const { callback } = await signIn(harness, READER)
    expect(callback.statusCode).toBe(302)
    expect(callback.headers.location).toBe('/')
    expect(await violations(redirect, callback.headers.location)).toEqual([])
    expect(callback.headers['cache-control']).toBe('no-store')
    const cookies = setCookies(callback.headers)
    expect(cookies).toHaveLength(2)
    expect(cookies).toContain('__Host-sr_login=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0')
    expect(cookies.find((cookie) => cookie.startsWith('__Host-sr_session='))).toMatch(
      /^__Host-sr_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict$/,
    )
  })

  it('never hands the browser an access, refresh or ID token (AC-8)', async () => {
    const { callback } = await signIn(harness, READER)
    const exposed = JSON.stringify(callback.headers) + callback.body
    expect(exposed).not.toContain('access-token-secret-value')
    expect(exposed).not.toContain('refresh-token-')
    expect(exposed).not.toMatch(/eyJ[A-Za-z0-9_-]+\.eyJ/)
  })

  it('stores only the SHA-256 hash of the session ID and the refresh token as AES-256-GCM ciphertext', async () => {
    const { session } = await signIn(harness, READER)
    const rows = [...harness.sessions.rows.values()]
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.idHash).toBe(sha256Hex(session ?? ''))
    expect(JSON.stringify(row)).not.toContain(session)
    expect(JSON.stringify(row)).not.toContain('refresh-token-')
    expect(open(harness.sessionKey, row.refreshTokenCiphertext, row.idHash)).toMatch(/^refresh-token-\d+-secret-value$/)
    expect(row).toMatchObject({
      account: 'm.duarte@contoso.com',
      displayName: 'Marta Duarte',
      roles: ['reader'],
      createdAt: harness.clock.now(),
      lastSeenAt: harness.clock.now(),
    })
  })

  it('sends the PKCE verifier and client credentials to the token endpoint', async () => {
    await signIn(harness, READER)
    const request = harness.keycloak.tokenRequests[0]!
    expect(request.get('grant_type')).toBe('authorization_code')
    expect(request.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{64}$/)
    expect(request.get('redirect_uri')).toBe('https://reports.contoso.test/auth/callback')
  })

  it('returns to the same-origin returnTo it started with', async () => {
    const { callback } = await signIn(harness, READER, { returnTo: '/approvals?resume=p-1' })
    expect(callback.headers.location).toBe('/approvals?resume=p-1')
    expect(await violations(redirect, callback.headers.location)).toEqual([])
  })

  it('rotates the session at login: a session the browser already held ends', async () => {
    const first = await signIn(harness, READER)
    const second = await signIn(harness, READER, { cookie: first.sessionCookie })
    expect(second.session).not.toBe(first.session)
    expect(harness.sessions.rows.has(sha256Hex(first.session ?? ''))).toBe(false)
    expect(harness.sessions.rows.size).toBe(1)
    expect((await harness.app.inject({ url: '/api/v1/me', headers: { cookie: first.sessionCookie } })).statusCode).toBe(
      401,
    )
  })

  it('lets an account in neither group sign in, holding no roles, so the denial can name it (AC-5)', async () => {
    const { callback } = await signIn(harness, OUTSIDER)
    expect(callback.statusCode).toBe(302)
    expect(await violations(redirect, callback.headers.location)).toEqual([])
    expect([...harness.sessions.rows.values()][0]?.roles).toEqual([])
  })
})

describe('GET /auth/callback — tampering is refused', () => {
  it('refuses a tampered state', async () => {
    const { location, loginCookie } = await startLogin()
    const { code } = harness.keycloak.issueCode(location, READER)
    await expectRefused(
      await harness.app.inject({ url: `/auth/callback?code=${code}&state=forged`, headers: { cookie: loginCookie } }),
    )
  })

  it('refuses a callback without the login transaction cookie, or with a tampered one', async () => {
    const { location, loginCookie } = await startLogin()
    const { code, state } = harness.keycloak.issueCode(location, READER)
    const url = `/auth/callback?code=${code}&state=${state}`
    await expectRefused(await harness.app.inject({ url }))
    await expectRefused(await harness.app.inject({ url, headers: { cookie: `${loginCookie.slice(0, -2)}AA` } }))
    await expectRefused(await harness.app.inject({ url, headers: { cookie: '__Host-sr_login=' } }))
  })

  it('refuses a callback without a code or state', async () => {
    const { loginCookie } = await startLogin()
    await expectRefused(await harness.app.inject({ url: '/auth/callback', headers: { cookie: loginCookie } }))
  })

  it('accepts the transaction one second before 5 minutes and refuses it at 5 minutes', async () => {
    const early = await startLogin()
    harness.clock.advance(299_999)
    const fresh = harness.keycloak.issueCode(early.location, READER)
    const accepted = await harness.app.inject({
      url: `/auth/callback?code=${fresh.code}&state=${fresh.state}`,
      headers: { cookie: early.loginCookie },
    })
    expect(accepted.statusCode).toBe(302)

    const late = await startLogin()
    harness.clock.advance(300_000)
    const stale = harness.keycloak.issueCode(late.location, READER)
    harness.sessions.rows.clear()
    await expectRefused(
      await harness.app.inject({
        url: `/auth/callback?code=${stale.code}&state=${stale.state}`,
        headers: { cookie: late.loginCookie },
      }),
    )
  })

  it('refuses a tampered PKCE verifier: a code bound to another sign-in’s challenge', async () => {
    const victim = await startLogin()
    const attacker = await startLogin()
    const { code } = harness.keycloak.issueCode(victim.location, READER)
    const state = new URL(attacker.location).searchParams.get('state')
    await expectRefused(
      await harness.app.inject({
        url: `/auth/callback?code=${code}&state=${state}`,
        headers: { cookie: attacker.loginCookie },
      }),
    )
  })

  it('refuses an ID token with a tampered nonce', async () => {
    harness.keycloak.idTokenOverrides = { nonce: 'replayed-nonce' }
    await expectRefused((await signIn(harness, READER)).callback)
  })

  it.each([
    ['another issuer', { iss: 'https://evil.test/realms/signin-reports' }],
    ['another audience', { aud: 'another-client' }],
    ['an expired token', { exp: 1_000 }],
    ['no account', { preferred_username: undefined }],
  ])('refuses an ID token from %s', async (_name, overrides) => {
    harness.keycloak.idTokenOverrides = overrides
    await expectRefused((await signIn(harness, READER)).callback)
  })

  it('refuses an ID token signed by a key the realm does not publish', async () => {
    harness.keycloak.signWith = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey
    await expectRefused((await signIn(harness, READER)).callback)
  })

  it('refuses an unsigned (alg none) ID token', async () => {
    harness.keycloak.idTokenHeaderOverrides = { alg: 'none' }
    await expectRefused((await signIn(harness, READER)).callback)
  })
})

describe('GET /auth/callback — sign-in did not complete at Microsoft (AC-6)', () => {
  const errorCallback = (query: string, state: string | null, cookie?: string) =>
    harness.app.inject({
      url: `/auth/callback?${query}&state=${encodeURIComponent(state ?? '')}`,
      headers: {
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        ...(cookie ? { cookie } : {}),
      },
    })
  const stateOf = (location: string) => new URL(location).searchParams.get('state')

  it('sends the browser to the error screen with the Entra code, a reference and a UTC timestamp, and audits it', async () => {
    const { location: authorize, loginCookie } = await startLogin()
    const description = 'AADSTS50126: Error validating credentials due to invalid username or password.'
    const response = await errorCallback(
      `error=access_denied&error_description=${encodeURIComponent(description)}`,
      stateOf(authorize),
      loginCookie,
    )
    expect(response.statusCode).toBe(302)
    expect(await violations(redirect, response.headers.location)).toEqual([])
    const location = new URL(String(response.headers.location), 'https://reports.contoso.test')
    expect(location.pathname).toBe('/signin/error')
    expect(location.searchParams.get('code')).toBe('AADSTS50126')
    expect(location.searchParams.get('at')).toBe('2026-10-19T08:00:00.000Z')
    const reference = location.searchParams.get('ref')
    expect(reference).toMatch(/^[A-Za-z0-9_-]{16}$/)
    expect(location.searchParams.toString()).not.toContain('invalid+username')
    expect(setCookies(response.headers)).toEqual([
      '__Host-sr_login=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    ])
    expect(harness.sessions.rows.size).toBe(0)
    expect(harness.audit.events).toEqual([
      {
        type: 'sign-in-failed',
        errorCode: 'AADSTS50126',
        reference,
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        at: new Date('2026-10-19T08:00:00.000Z'),
      },
    ])
  })

  it('falls back to the OAuth error when no Entra code is given, and never echoes an unsafe one', async () => {
    const first = await startLogin()
    const plain = await errorCallback('error=temporarily_unavailable', stateOf(first.location), first.loginCookie)
    expect(await violations(redirect, plain.headers.location)).toEqual([])
    expect(new URL(String(plain.headers.location), 'https://x.test').searchParams.get('code')).toBe(
      'temporarily_unavailable',
    )
    const second = await startLogin()
    const unsafe = await errorCallback(
      `error=${encodeURIComponent('<script>')}`,
      stateOf(second.location),
      second.loginCookie,
    )
    expect(await violations(redirect, unsafe.headers.location)).toEqual([])
    expect(new URL(String(unsafe.headers.location), 'https://x.test').searchParams.get('code')).toBe('unknown_error')
  })

  it('refuses an error callback without the transaction cookie, or with a forged state, and audits nothing', async () => {
    const { location, loginCookie } = await startLogin()
    const query = `error=access_denied&error_description=${encodeURIComponent('AADSTS50126: forged')}`
    await expectRefused(await errorCallback(query, stateOf(location)))
    await expectRefused(await errorCallback(query, 'forged', loginCookie))
    await expectRefused(await errorCallback(query, null, loginCookie))
    expect(harness.audit.events).toEqual([])
  })
})
