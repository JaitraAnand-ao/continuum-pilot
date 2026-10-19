import { generateKeyPairSync, sign } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { createKeycloakClient } from '../src/keycloak-client.js'
import { OidcRejectedError, OidcUnavailableError } from '../src/oidc.js'
import { Secret } from '../src/secret.js'
import { FixedClock } from './support/clock.js'

const ISSUER = 'https://keycloak.contoso.test/realms/signin-reports'
const BASE = `${ISSUER}/protocol/openid-connect`
const CLIENT_ID = 'signin-reports-bff'
const NOW_S = Date.parse('2026-10-19T08:00:00.000Z') / 1000

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function idToken(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'k1', ...header })
  const body = b64({
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: 'sub-1',
    exp: NOW_S + 300,
    iat: NOW_S,
    auth_time: NOW_S - 10,
    nonce: 'the-nonce',
    upn: 'm.duarte@contoso.com',
    name: 'M. Duarte',
    roles: ['reader', 'config.read'],
    ...claims,
  })
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')
  return `${head}.${body}.${signature}`
}

interface Call {
  url: string
  init: RequestInit | undefined
}

class FakeKeycloak {
  calls: Call[] = []
  discovery: { status: number; body: unknown } = {
    status: 200,
    body: {
      issuer: ISSUER,
      authorization_endpoint: `${BASE}/auth`,
      token_endpoint: `${BASE}/token`,
      end_session_endpoint: `${BASE}/logout`,
      jwks_uri: `${BASE}/certs`,
    },
  }
  jwks: { status: number; body: unknown } = { status: 200, body: { keys: [jwk, { kty: 'EC', kid: 'ec' }] } }
  token: { status: number; body: unknown } = {
    status: 200,
    body: { id_token: idToken(), refresh_token: 'refresh-1', access_token: 'access-1' },
  }
  logout = { status: 204, body: null as unknown }
  unreachable = false

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    this.calls.push({ url, init })
    if (this.unreachable) throw new TypeError('fetch failed')
    const route = {
      [`${ISSUER}/.well-known/openid-configuration`]: this.discovery,
      [`${BASE}/certs`]: this.jwks,
      [`${BASE}/token`]: this.token,
      [`${BASE}/logout`]: this.logout,
    }[url]
    if (route === undefined) return new Response('not found', { status: 404 })
    const body = route.body === null ? null : typeof route.body === 'string' ? route.body : JSON.stringify(route.body)
    return new Response(body, { status: route.status })
  }

  form(path: string): URLSearchParams {
    const call = this.calls.find((c) => c.url === `${BASE}/${path}`)
    return new URLSearchParams(String(call?.init?.body))
  }
}

let keycloak: FakeKeycloak
let clock: FixedClock

function client() {
  return createKeycloakClient({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: new Secret('client-secret-value'),
    clock,
    fetch: keycloak.fetch,
  })
}

const exchange = {
  code: 'the-code',
  codeVerifier: 'the-verifier',
  redirectUri: 'https://r.test/auth/callback',
  nonce: 'the-nonce',
}

beforeEach(() => {
  keycloak = new FakeKeycloak()
  clock = new FixedClock('2026-10-19T08:00:00.000Z')
})

describe('Keycloak authorization request (IF-1)', () => {
  it('asks for a code with PKCE S256, state, nonce and the Microsoft hint', async () => {
    const url = new URL(
      await client().authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c', redirectUri: 'https://r.test/cb' }),
    )
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/auth`)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: 'https://r.test/cb',
      scope: 'openid profile',
      state: 's',
      nonce: 'n',
      code_challenge: 'c',
      code_challenge_method: 'S256',
      kc_idp_hint: 'microsoft',
    })
  })

  it('passes max_age when re-authentication is forced', async () => {
    const url = await client().authorizationUrl({
      state: 's',
      nonce: 'n',
      codeChallenge: 'c',
      redirectUri: 'x',
      maxAge: 0,
    })
    expect(new URL(url).searchParams.get('max_age')).toBe('0')
  })

  it('discovers once and reuses the result', async () => {
    const oidc = client()
    await oidc.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c', redirectUri: 'x' })
    await oidc.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c', redirectUri: 'x' })
    expect(keycloak.calls).toHaveLength(1)
  })

  it('reports discovery as unavailable, and retries it on the next call', async () => {
    const oidc = client()
    keycloak.discovery = { status: 503, body: 'down' }
    await expect(
      oidc.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c', redirectUri: 'x' }),
    ).rejects.toThrow(OidcUnavailableError)
    keycloak.discovery = { status: 200, body: { authorization_endpoint: 1 } }
    await expect(
      oidc.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c', redirectUri: 'x' }),
    ).rejects.toThrow(OidcUnavailableError)
    keycloak.discovery = { status: 200, body: null }
    await expect(
      oidc.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c', redirectUri: 'x' }),
    ).rejects.toThrow(OidcUnavailableError)
    keycloak.unreachable = true
    await expect(
      oidc.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c', redirectUri: 'x' }),
    ).rejects.toThrow(OidcUnavailableError)
  })
})

describe('Keycloak code exchange and ID token validation', () => {
  it('exchanges the code with the PKCE verifier and returns the identity and refresh token', async () => {
    const signIn = await client().completeSignIn(exchange)
    expect(signIn).toEqual({
      identity: {
        subject: 'sub-1',
        account: 'm.duarte@contoso.com',
        displayName: 'M. Duarte',
        roles: ['reader', 'config.read'],
        authTime: new Date((NOW_S - 10) * 1000),
      },
      refreshToken: 'refresh-1',
    })
    expect(Object.fromEntries(keycloak.form('token'))).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      code_verifier: 'the-verifier',
      redirect_uri: 'https://r.test/auth/callback',
      client_id: CLIENT_ID,
      client_secret: 'client-secret-value',
    })
  })

  it('rejects a code Keycloak refuses, as it does for a wrong PKCE verifier', async () => {
    keycloak.token = { status: 400, body: { error: 'invalid_grant', error_description: 'PKCE verification failed' } }
    await expect(client().completeSignIn(exchange)).rejects.toThrow(OidcRejectedError)
  })

  it('treats a failing token endpoint as unavailable', async () => {
    keycloak.token = { status: 502, body: 'bad gateway' }
    await expect(client().completeSignIn(exchange)).rejects.toThrow(OidcUnavailableError)
  })

  it('rejects a token whose nonce does not match the login transaction', async () => {
    await expect(client().completeSignIn({ ...exchange, nonce: 'other' })).rejects.toThrow(/nonce/)
  })

  it.each([
    ['issuer', { iss: 'https://evil.test' }, /issuer/],
    ['audience', { aud: ['other-client'] }, /audience/],
    ['expired one minute past exp', { exp: NOW_S - 60 }, /expired/],
    ['missing exp', { exp: undefined }, /expired/],
    ['missing subject', { sub: undefined }, /no account/],
    ['missing account', { upn: undefined, preferred_username: '', email: undefined }, /no account/],
  ])('rejects a token with a wrong %s', async (_, claims, message) => {
    keycloak.token = { status: 200, body: { id_token: idToken(claims) } }
    await expect(client().completeSignIn(exchange)).rejects.toThrow(message)
  })

  it('accepts a token within the 60-second clock skew of exp', async () => {
    keycloak.token = { status: 200, body: { id_token: idToken({ exp: NOW_S - 59, aud: [CLIENT_ID, 'x'] }) } }
    await expect(client().completeSignIn(exchange)).resolves.toMatchObject({ refreshToken: null })
  })

  it('falls back to preferred_username, the account as display name and now as auth time', async () => {
    keycloak.token = {
      status: 200,
      body: {
        id_token: idToken({
          upn: undefined,
          preferred_username: 'p@contoso.com',
          name: undefined,
          auth_time: undefined,
          roles: undefined,
        }),
      },
    }
    const { identity } = await client().completeSignIn(exchange)
    expect(identity).toMatchObject({ account: 'p@contoso.com', displayName: 'p@contoso.com', roles: [] })
    expect(identity.authTime.toISOString()).toBe('2026-10-19T08:00:00.000Z')
  })

  it('rejects a forged signature, an unknown key, a foreign algorithm and malformed tokens', async () => {
    const [head, body] = idToken().split('.') as [string, string]
    const forged = `${head}.${b64({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), roles: ['reader'] })}.${idToken().split('.')[2]}`
    for (const [token, message] of [
      [forged, /signature/],
      [idToken({}, { kid: 'k2' }), /unknown key/],
      [idToken({}, { alg: 'none' }), /algorithm/],
      ['a.b', /malformed/],
      [`${b64('text')}.x.y`, /malformed/],
      ['%%%.x.y', /malformed/],
    ] as const) {
      keycloak.token = { status: 200, body: { id_token: token } }
      await expect(client().completeSignIn(exchange)).rejects.toThrow(message)
    }
    keycloak.token = { status: 200, body: { access_token: 'only' } }
    await expect(client().completeSignIn(exchange)).rejects.toThrow(/refused/)
  })

  it('refetches the JWKS once for an unseen key and reports an unusable JWKS', async () => {
    const oidc = client()
    await oidc.completeSignIn(exchange)
    await oidc.completeSignIn(exchange)
    expect(keycloak.calls.filter((c) => c.url.endsWith('/certs'))).toHaveLength(1)
    keycloak.jwks = { status: 500, body: {} }
    keycloak.token = { status: 200, body: { id_token: idToken({}, { kid: 'rotated' }) } }
    await expect(oidc.completeSignIn(exchange)).rejects.toThrow(OidcUnavailableError)
  })
})

describe('Keycloak logout (AC-9)', () => {
  it('ends the Keycloak session with the refresh token', async () => {
    await client().endSession('refresh-1')
    expect(Object.fromEntries(keycloak.form('logout'))).toEqual({
      client_id: CLIENT_ID,
      client_secret: 'client-secret-value',
      refresh_token: 'refresh-1',
    })
  })

  it('reports a refused logout', async () => {
    keycloak.logout = { status: 400, body: { error: 'invalid_grant' } }
    await expect(client().endSession('refresh-1')).rejects.toThrow(OidcUnavailableError)
  })
})
