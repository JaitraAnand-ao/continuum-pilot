/* The Keycloak OIDC client (consumes IF-10 discovery and keys, IF-11 token and logout) against the fake realm. */
import { beforeEach, describe, expect, it } from 'vitest'
import { createOidcClient, OidcRejectedError, OidcUnavailableError } from '../src/auth/oidc.js'
import { Secret } from '../src/config.js'
import { pkceChallenge, randomToken } from '../src/security/crypto.js'
import { CLIENT_ID, CLIENT_SECRET, createFakeKeycloak, ISSUER, READER, signJwt } from './support/fake-keycloak.js'
import { TestClock } from './support/harness.js'

const REDIRECT = 'https://reports.contoso.test/auth/callback'

function setup(secret = CLIENT_SECRET) {
  const clock = new TestClock(new Date('2026-10-19T08:00:00.000Z'))
  const keycloak = createFakeKeycloak(() => clock.now())
  const client = createOidcClient({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: new Secret(secret),
    redirectUri: REDIRECT,
    idpHint: 'microsoft',
    fetch: keycloak.fetch,
    clock,
  })
  return { clock, keycloak, client }
}

async function authorizeAs(s: ReturnType<typeof setup>, nonce = randomToken(), verifier = randomToken()) {
  const location = await s.client.authorizationUrl({
    state: randomToken(),
    nonce,
    codeChallenge: pkceChallenge(verifier),
  })
  const { code } = s.keycloak.authorize(location, READER)
  return { code, nonce, verifier }
}

describe('authorizationUrl', () => {
  it('asks Keycloak for the code flow with PKCE S256, state, nonce and the Microsoft IdP hint', async () => {
    const { client } = setup()
    const url = new URL(await client.authorizationUrl({ state: 'st', nonce: 'nc', codeChallenge: 'ch', maxAge: 0 }))
    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/protocol/openid-connect/auth`)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      scope: 'openid profile email',
      state: 'st',
      nonce: 'nc',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      kc_idp_hint: 'microsoft',
      max_age: '0',
    })
  })

  it('leaves max_age out unless asked, and reads discovery only once', async () => {
    const { client, keycloak } = setup()
    const url = new URL(await client.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' }))
    await client.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' })
    expect(url.searchParams.has('max_age')).toBe(false)
    expect(keycloak.state.discoveryRequests).toBe(1)
  })

  it('reports Keycloak unavailable when discovery fails, and retries discovery next time', async () => {
    const { client, keycloak } = setup()
    keycloak.state.discoveryDown = true
    await expect(client.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' })).rejects.toBeInstanceOf(
      OidcUnavailableError,
    )
    keycloak.state.discoveryDown = false
    await expect(client.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' })).resolves.toContain(ISSUER)
  })

  it('reports Keycloak unavailable when the network fails or discovery names another issuer', async () => {
    const failing = createOidcClient({
      ...baseOptions(),
      fetch: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    await expect(failing.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' })).rejects.toBeInstanceOf(
      OidcUnavailableError,
    )
    const impostor = createOidcClient({
      ...baseOptions(),
      fetch: async () => new Response(JSON.stringify({ issuer: 'https://evil.test' }), { status: 200 }),
    })
    await expect(impostor.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' })).rejects.toBeInstanceOf(
      OidcUnavailableError,
    )
  })
})

function baseOptions() {
  return {
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: new Secret(CLIENT_SECRET),
    redirectUri: REDIRECT,
    idpHint: 'microsoft',
    clock: new TestClock(new Date('2026-10-19T08:00:00.000Z')),
  }
}

describe('exchangeCode', () => {
  let s: ReturnType<typeof setup>
  beforeEach(() => {
    s = setup()
  })

  it('returns the validated ID token claims and the refresh token, never the access token', async () => {
    const { code, nonce, verifier } = await authorizeAs(s)
    const result = await s.client.exchangeCode({ code, codeVerifier: verifier, nonce })
    expect(result.claims).toMatchObject({ sub: READER.sub, upn: READER.upn, roles: ['reader'], nonce })
    expect(result.refreshToken).toMatch(/^refresh-/)
    expect(JSON.stringify(result)).not.toContain('access-')
  })

  it('rejects a tampered PKCE verifier (Keycloak refuses the code)', async () => {
    const { code, nonce } = await authorizeAs(s)
    await expect(s.client.exchangeCode({ code, codeVerifier: randomToken(), nonce })).rejects.toBeInstanceOf(
      OidcRejectedError,
    )
  })

  it('rejects an ID token whose nonce is not the one this login sent', async () => {
    const { code, verifier } = await authorizeAs(s)
    await expect(s.client.exchangeCode({ code, codeVerifier: verifier, nonce: 'another' })).rejects.toBeInstanceOf(
      OidcRejectedError,
    )
  })

  it.each([
    ['another issuer', { iss: 'https://evil.test/realms/x' }],
    ['another audience', { aud: 'someone-else' }],
    ['an audience list without this client', { aud: ['a', 'b'] }],
    ['an audience list with a foreign authorized party', { aud: [CLIENT_ID, 'b'], azp: 'b' }],
    ['an expired token', { exp: Math.floor(Date.parse('2026-10-19T08:00:00.000Z') / 1000) }],
    ['a token issued in the future', { iat: Math.floor(Date.parse('2026-10-19T08:05:00.000Z') / 1000) }],
    ['no subject', { sub: undefined }],
  ])('rejects an ID token with %s', async (_, overrides) => {
    const { code, nonce, verifier } = await authorizeAs(s)
    s.keycloak.state.idTokenOverrides = overrides
    await expect(s.client.exchangeCode({ code, codeVerifier: verifier, nonce })).rejects.toBeInstanceOf(
      OidcRejectedError,
    )
  })

  it('accepts an audience list holding this client when it is the authorized party', async () => {
    const { code, nonce, verifier } = await authorizeAs(s)
    s.keycloak.state.idTokenOverrides = { aud: [CLIENT_ID, 'account'], azp: CLIENT_ID }
    await expect(s.client.exchangeCode({ code, codeVerifier: verifier, nonce })).resolves.toBeDefined()
  })

  it('accepts an ID token that expires one second after now', async () => {
    const { code, nonce, verifier } = await authorizeAs(s)
    s.keycloak.state.idTokenOverrides = { exp: Math.floor(Date.parse('2026-10-19T08:00:01.000Z') / 1000) }
    await expect(s.client.exchangeCode({ code, codeVerifier: verifier, nonce })).resolves.toBeDefined()
  })

  it('rejects an ID token signed by a key the realm does not publish', async () => {
    const { code, nonce, verifier } = await authorizeAs(s)
    s.keycloak.state.signWithForeignKey = true
    await expect(s.client.exchangeCode({ code, codeVerifier: verifier, nonce })).rejects.toBeInstanceOf(
      OidcRejectedError,
    )
  })

  it('rejects malformed or unsigned tokens from a token endpoint that misbehaves', async () => {
    for (const idToken of [
      'not-a-jwt',
      `${Buffer.from('{"alg":"none"}').toString('base64url')}.e30.`,
      `${Buffer.from('{"alg":"RS256","kid":"unknown"}').toString('base64url')}.e30.c2ln`,
      `${Buffer.from('not json').toString('base64url')}.e30.c2ln`,
      undefined,
    ]) {
      const client = createOidcClient({
        ...baseOptions(),
        fetch: async (input, init) => {
          const url = String(input)
          if (init?.method === 'POST') return Response.json({ id_token: idToken })
          if (url.endsWith('/certs')) return Response.json({ keys: [] })
          return s.keycloak.fetch(input, init)
        },
      })
      await expect(client.exchangeCode({ code: 'c', codeVerifier: 'v', nonce: 'n' })).rejects.toBeInstanceOf(
        OidcRejectedError,
      )
    }
  })

  it('rejects a well-signed token whose payload is not JSON', async () => {
    const forged = signJwt({}, s.keycloak.privateKey, s.keycloak.kid).split('.')
    const token = `${forged[0]}.${Buffer.from('nope').toString('base64url')}.${forged[2]}`
    const client = createOidcClient({
      ...baseOptions(),
      fetch: async (input, init) =>
        init?.method === 'POST' ? Response.json({ id_token: token }) : s.keycloak.fetch(input, init),
    })
    await expect(client.exchangeCode({ code: 'c', codeVerifier: 'v', nonce: 'n' })).rejects.toBeInstanceOf(
      OidcRejectedError,
    )
  })

  it('reports Keycloak unavailable when the token endpoint is down', async () => {
    const { code, nonce, verifier } = await authorizeAs(s)
    s.keycloak.state.tokenEndpointDown = true
    await expect(s.client.exchangeCode({ code, codeVerifier: verifier, nonce })).rejects.toBeInstanceOf(
      OidcUnavailableError,
    )
  })

  it('reports a wrong client secret as rejected, without the secret in the error', async () => {
    const wrong = setup('not-the-secret')
    const { code, nonce, verifier } = await authorizeAs(wrong)
    const error = await wrong.client.exchangeCode({ code, codeVerifier: verifier, nonce }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OidcRejectedError)
    expect(String((error as Error).message)).not.toContain('not-the-secret')
  })

  it('works without a refresh token', async () => {
    const { code, nonce, verifier } = await authorizeAs(s)
    s.keycloak.state.omitRefreshToken = true
    const result = await s.client.exchangeCode({ code, codeVerifier: verifier, nonce })
    expect(result.refreshToken).toBeUndefined()
  })
})

describe('endSession', () => {
  it('ends the Keycloak session with the refresh token', async () => {
    const s = setup()
    await s.client.endSession('refresh-abc')
    expect(s.keycloak.state.endedRefreshTokens).toEqual(['refresh-abc'])
  })

  it('reports a refused or unreachable logout as unavailable', async () => {
    const wrong = setup('not-the-secret')
    await expect(wrong.client.endSession('refresh-abc')).rejects.toBeInstanceOf(OidcUnavailableError)
    const s = setup()
    s.keycloak.state.discoveryDown = true
    await expect(s.client.endSession('refresh-abc')).rejects.toBeInstanceOf(OidcUnavailableError)
  })
})
