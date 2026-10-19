import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startFakeKeycloak, type FakeKeycloak } from '../test/fake-keycloak'
import { Secret } from './config'
import { pkceChallenge } from './crypto'
import { OidcRejectedError, OidcUnavailableError, createKeycloakClient, type OidcClient } from './oidc'

const now = new Date('2026-10-19T08:00:00.000Z')
const seconds = Math.floor(now.getTime() / 1000)
const redirectUri = 'https://reports.example.test/auth/callback'

let keycloak: FakeKeycloak
let client: OidcClient

const claims = (overrides: Record<string, unknown> = {}) => ({
  iss: keycloak.issuer,
  aud: keycloak.clientId,
  sub: 'subject-1',
  iat: seconds,
  exp: seconds + 300,
  auth_time: seconds - 5,
  nonce: 'the-nonce',
  preferred_username: 'm.duarte@contoso.com',
  name: 'M. Duarte',
  roles: ['SignInReports.Reader'],
  ...overrides,
})

const exchange = (tokenClaims: Record<string, unknown>, verifier = 'v'.repeat(43)) =>
  client.exchangeCode({
    code: keycloak.issueCode({ challenge: pkceChallenge('v'.repeat(43)), claims: tokenClaims }),
    codeVerifier: verifier,
    redirectUri,
    nonce: 'the-nonce',
  })

beforeAll(async () => {
  keycloak = await startFakeKeycloak()
})
afterAll(() => keycloak.close())
beforeEach(() => {
  keycloak.failDiscovery = false
  keycloak.failToken = false
  client = createKeycloakClient({
    issuer: keycloak.issuer,
    clientId: keycloak.clientId,
    clientSecret: new Secret(keycloak.clientSecret),
    clock: { now: () => now },
  })
})

describe('Keycloak OIDC client (consumes IF-10 and IF-11)', () => {
  it('builds the authorization URL with PKCE S256, state, nonce and the Microsoft hint', async () => {
    const url = new URL(
      await client.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c', redirectUri, maxAge: 0 }),
    )
    expect(`${url.origin}${url.pathname}`).toBe(`${keycloak.issuer}/protocol/openid-connect/auth`)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: keycloak.clientId,
      redirect_uri: redirectUri,
      scope: 'openid profile email',
      state: 's',
      nonce: 'n',
      code_challenge: 'c',
      code_challenge_method: 'S256',
      kc_idp_hint: 'microsoft',
      max_age: '0',
    })
  })

  it('omits max_age when none is asked for', async () => {
    const url = new URL(await client.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c', redirectUri }))
    expect(url.searchParams.has('max_age')).toBe(false)
  })

  it('reports discovery failure as unavailable', async () => {
    keycloak.failDiscovery = true
    await expect(client.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c', redirectUri })).rejects.toThrow(
      OidcUnavailableError,
    )
  })

  it('reports an unreachable Keycloak as unavailable', async () => {
    const offline = createKeycloakClient({
      issuer: 'http://127.0.0.1:1/realms/signin-reports',
      clientId: 'x',
      clientSecret: new Secret('y'),
      clock: { now: () => now },
    })
    await expect(offline.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c', redirectUri })).rejects.toThrow(
      OidcUnavailableError,
    )
  })

  it('exchanges the code with the verifier and returns the verified claims', async () => {
    const tokens = await exchange(claims())
    expect(tokens.refreshToken).toBe('kc-refresh-token-value')
    expect(tokens.claims.preferred_username).toBe('m.duarte@contoso.com')
    expect(tokens.idToken.split('.')).toHaveLength(3)
    const request = keycloak.tokenRequests.at(-1)
    expect(request).toMatchObject({ grant_type: 'authorization_code', redirect_uri: redirectUri })
    expect(request?.code_verifier).toBe('v'.repeat(43))
  })

  it('rejects a tampered PKCE verifier', async () => {
    await expect(exchange(claims(), 'w'.repeat(43))).rejects.toThrow(OidcRejectedError)
  })

  it('rejects a token endpoint failure', async () => {
    keycloak.failToken = true
    await expect(exchange(claims())).rejects.toThrow(OidcRejectedError)
  })

  it.each([
    ['a tampered nonce', { nonce: 'other' }],
    ['a foreign issuer', { iss: 'https://evil.example/realms/x' }],
    ['another audience', { aud: 'someone-else' }],
    ['an expired token', { exp: seconds }],
    ['a token issued in the future', { iat: seconds + 120 }],
  ])('rejects an ID token with %s', async (_label, overrides) => {
    await expect(exchange(claims(overrides))).rejects.toThrow(OidcRejectedError)
  })

  it('accepts an audience array holding the client and a token one second before expiry', async () => {
    await expect(exchange(claims({ aud: ['x', keycloak.clientId], exp: seconds + 1 }))).resolves.toBeDefined()
  })

  it('verifies the signature, refusing a forged or unsigned token', async () => {
    const good = keycloak.signIdToken(claims())
    const [head, , signature] = good.split('.')
    const forgedBody = Buffer.from(JSON.stringify(claims({ roles: ['SignInReports.Admin'] }))).toString('base64url')
    await expect(client.verifyIdToken(`${head}.${forgedBody}.${signature}`, 'the-nonce')).rejects.toThrow(
      OidcRejectedError,
    )
    const none = Buffer.from(JSON.stringify({ alg: 'none', kid: 'test-key' })).toString('base64url')
    await expect(client.verifyIdToken(`${none}.${forgedBody}.`, 'the-nonce')).rejects.toThrow(OidcRejectedError)
    await expect(client.verifyIdToken(keycloak.signIdToken(claims(), { kid: 'unknown' }), 'the-nonce')).rejects.toThrow(
      OidcRejectedError,
    )
    await expect(client.verifyIdToken('not-a-jwt', 'the-nonce')).rejects.toThrow(OidcRejectedError)
    await expect(client.verifyIdToken(good, 'the-nonce')).resolves.toMatchObject({ sub: 'subject-1' })
  })

  it('builds the end-session URL so logout ends the Keycloak session', async () => {
    const url = new URL(
      await client.endSessionUrl({ idToken: 'id.token.value', postLogoutRedirectUri: 'https://reports.example.test/' }),
    )
    expect(`${url.origin}${url.pathname}`).toBe(`${keycloak.issuer}/protocol/openid-connect/logout`)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      id_token_hint: 'id.token.value',
      client_id: keycloak.clientId,
      post_logout_redirect_uri: 'https://reports.example.test/',
    })
  })
})
