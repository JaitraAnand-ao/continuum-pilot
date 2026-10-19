/* The Keycloak OIDC adapter against the fake realm: discovery, ID-token verification and its refusals. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IdpUnavailableError, KeycloakOidcClient, TokenRejectedError } from '../src/auth/oidc.js'
import { Secret } from '../src/secret.js'
import { CLIENT_ID, CLIENT_SECRET, FakeKeycloak } from './support/fake-keycloak.js'
import './support/harness.js'

const NOW = new Date('2026-10-19T08:00:00.000Z')
let keycloak: FakeKeycloak
let client: KeycloakOidcClient

const clientFor = (issuer: string) =>
  new KeycloakOidcClient({
    issuer,
    clientId: CLIENT_ID,
    clientSecret: new Secret(CLIENT_SECRET),
    redirectUri: 'https://reports.contoso.test/auth/callback',
    idpHint: 'microsoft',
    timeoutMs: 2000,
  })

const claims = (overrides: Record<string, unknown> = {}) => ({
  iss: keycloak.issuer,
  aud: CLIENT_ID,
  exp: NOW.getTime() / 1000 + 300,
  iat: NOW.getTime() / 1000,
  nonce: 'n-1',
  preferred_username: 'm.duarte@contoso.com',
  ...overrides,
})

beforeEach(async () => {
  keycloak = await new FakeKeycloak().start()
  client = clientFor(keycloak.issuer)
})
afterEach(async () => {
  await keycloak.stop()
})

describe('KeycloakOidcClient', () => {
  it('accepts a valid token, an audience list, and falls back from preferred_username to upn and name to account', async () => {
    const token = keycloak.idToken(
      claims({ aud: ['account', CLIENT_ID], preferred_username: undefined, upn: 'u@contoso.com' }),
    )
    await expect(client.verifyIdToken(token, 'n-1', NOW)).resolves.toEqual({
      account: 'u@contoso.com',
      displayName: 'u@contoso.com',
      roles: undefined,
      authTime: NOW,
    })
  })

  it('accepts a token within the 60-second clock skew and refuses it at the skew limit', async () => {
    const at = (seconds: number) => claims({ exp: NOW.getTime() / 1000 - seconds })
    await expect(client.verifyIdToken(keycloak.idToken(at(59)), 'n-1', NOW)).resolves.toBeDefined()
    await expect(client.verifyIdToken(keycloak.idToken(at(60)), 'n-1', NOW)).rejects.toThrow('expired')
  })

  it.each([
    ['two segments', 'a.b'],
    ['a header that is not JSON', 'bm90LWpzb24.e30.'],
    ['a header that is an array', `${Buffer.from('[]').toString('base64url')}.e30.`],
  ])('refuses a malformed token: %s', async (_name, token) => {
    await expect(client.verifyIdToken(token, 'n-1', NOW)).rejects.toBeInstanceOf(TokenRejectedError)
  })

  it('refuses a token with no kid, an unknown kid, or no auth time', async () => {
    await expect(client.verifyIdToken(keycloak.idToken(claims(), { kid: undefined }), 'n-1', NOW)).rejects.toThrow(
      'algorithm',
    )
    await expect(client.verifyIdToken(keycloak.idToken(claims(), { kid: 'other' }), 'n-1', NOW)).rejects.toThrow(
      'unknown key',
    )
    await expect(client.verifyIdToken(keycloak.idToken(claims({ iat: undefined })), 'n-1', NOW)).rejects.toThrow(
      'auth_time',
    )
  })

  it('refuses a token whose account is not a UPN', async () => {
    const token = keycloak.idToken(claims({ preferred_username: 'not a upn' }))
    await expect(client.verifyIdToken(token, 'n-1', NOW)).rejects.toThrow('account')
  })

  it('is unavailable when discovery names another issuer, lacks an endpoint, or cannot be reached', async () => {
    await expect(
      clientFor(`${keycloak.issuer}-other`).authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' }),
    ).rejects.toBeInstanceOf(IdpUnavailableError)
    await expect(clientFor('http://127.0.0.1:1/realms/x').exchangeCode('code', 'verifier')).rejects.toBeInstanceOf(
      IdpUnavailableError,
    )
  })

  it('refuses a code exchange the token endpoint rejects, or that cannot reach it', async () => {
    await expect(client.exchangeCode('unknown-code', 'verifier')).rejects.toThrow('code exchange failed')
    await client.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' })
    await keycloak.stop()
    await expect(client.exchangeCode('unknown-code', 'verifier')).rejects.toThrow('code exchange failed')
    keycloak = await new FakeKeycloak().start()
  })

  it('reports a logout Keycloak refuses', async () => {
    keycloak.logoutStatus = 400
    await expect(client.endSession('refresh')).rejects.toThrow('logout refused')
  })

  it('is unavailable when the JWKS cannot be fetched', async () => {
    const token = keycloak.idToken(claims())
    await client.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' })
    await keycloak.stop()
    await expect(client.verifyIdToken(token, 'n-1', NOW)).rejects.toBeInstanceOf(IdpUnavailableError)
    keycloak = await new FakeKeycloak().start()
  })
})
