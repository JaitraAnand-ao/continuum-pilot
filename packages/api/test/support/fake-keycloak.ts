/* Test-only stand-in for the Keycloak signin-reports realm (IF-10 discovery and keys, IF-11 token and logout).
 * It answers through an injected fetch, signs ID tokens with its own RSA key and enforces PKCE like Keycloak does. */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'

export const ISSUER = 'https://keycloak.test/realms/signin-reports'
export const CLIENT_ID = 'signin-reports-bff'
export const CLIENT_SECRET = 'bff-client-secret-for-tests'

export interface FakeUser {
  sub: string
  upn: string
  name: string
  roles: string[]
}

export const READER: FakeUser = { sub: 'u-reader', upn: 'r.reader@contoso.com', name: 'Rita Reader', roles: ['reader'] }
export const BOTH: FakeUser = {
  sub: 'u-both',
  upn: 'm.duarte@contoso.com',
  name: 'Marta Duarte',
  roles: ['reader', 'config.read', 'config.write', 'config.approve'],
}
export const ADMIN_ONLY: FakeUser = {
  sub: 'u-admin',
  upn: 'a.admin@contoso.com',
  name: 'Ana Admin',
  roles: ['config.read', 'config.write', 'config.approve'],
}
export const OUTSIDER: FakeUser = { sub: 'u-out', upn: 'o.outsider@contoso.com', name: 'Otto Outsider', roles: [] }

interface PendingCode {
  challenge: string
  nonce: string
  redirectUri: string
  user: FakeUser
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

export function signJwt(claims: Record<string, unknown>, key: KeyObject, kid: string): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }))
  const payload = base64url(JSON.stringify(claims))
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key)
  return `${header}.${payload}.${base64url(signature)}`
}

/* Generated once per test file: RSA key generation is slow enough to time out a beforeEach under parallel workers. */
const realmKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const foreign = generateKeyPairSync('rsa', { modulusLength: 2048 })

export function createFakeKeycloak(now: () => Date) {
  const { privateKey, publicKey } = realmKeys
  const kid = 'realm-key-1'
  const codes = new Map<string, PendingCode>()
  const state = {
    discoveryDown: false,
    tokenEndpointDown: false,
    logoutDown: false,
    /* Claims merged into the next ID token, to forge a nonce, audience, issuer or expiry. */
    idTokenOverrides: undefined as Record<string, unknown> | undefined,
    signWithForeignKey: false,
    omitRefreshToken: false,
    tokenRequests: 0,
    discoveryRequests: 0,
    endedRefreshTokens: [] as string[],
    issuedTokens: [] as string[],
  }

  const discovery = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
    token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
    jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
    end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '')
    if (url === `${ISSUER}/.well-known/openid-configuration` && method === 'GET') {
      state.discoveryRequests += 1
      if (state.discoveryDown) return new Response('unavailable', { status: 503 })
      return json(discovery)
    }
    if (url === discovery.jwks_uri && method === 'GET') {
      const jwk = publicKey.export({ format: 'jwk' })
      return json({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] })
    }
    if (url === discovery.token_endpoint && method === 'POST') {
      state.tokenRequests += 1
      if (state.tokenEndpointDown) return new Response('down', { status: 502 })
      if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) {
        return json({ error: 'invalid_client' }, 401)
      }
      const code = form.get('code') ?? ''
      const pending = codes.get(code)
      codes.delete(code)
      if (form.get('grant_type') !== 'authorization_code' || !pending) return json({ error: 'invalid_grant' }, 400)
      if (form.get('redirect_uri') !== pending.redirectUri) return json({ error: 'invalid_grant' }, 400)
      const verifier = form.get('code_verifier') ?? ''
      if (base64url(createHash('sha256').update(verifier).digest()) !== pending.challenge) {
        return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400)
      }
      const issuedAt = Math.floor(now().getTime() / 1000)
      const claims = {
        iss: ISSUER,
        aud: CLIENT_ID,
        azp: CLIENT_ID,
        sub: pending.user.sub,
        iat: issuedAt,
        exp: issuedAt + 300,
        auth_time: issuedAt,
        nonce: pending.nonce,
        upn: pending.user.upn,
        preferred_username: pending.user.upn,
        name: pending.user.name,
        roles: pending.user.roles,
        ...state.idTokenOverrides,
      }
      state.idTokenOverrides = undefined
      const idToken = signJwt(claims, state.signWithForeignKey ? foreign.privateKey : privateKey, kid)
      const accessToken = `access-${randomBytes(12).toString('hex')}`
      const refreshToken = `refresh-${randomBytes(12).toString('hex')}`
      state.issuedTokens.push(idToken, accessToken, refreshToken)
      return json({
        token_type: 'Bearer',
        expires_in: 300,
        id_token: idToken,
        access_token: accessToken,
        ...(state.omitRefreshToken ? {} : { refresh_token: refreshToken }),
      })
    }
    if (url === discovery.end_session_endpoint && method === 'POST') {
      if (state.logoutDown) return new Response('down', { status: 502 })
      if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) {
        return json({ error: 'invalid_client' }, 401)
      }
      state.endedRefreshTokens.push(form.get('refresh_token') ?? '')
      return new Response(null, { status: 204 })
    }
    return new Response('not found', { status: 404 })
  }

  /* Plays the browser at Keycloak and Microsoft: reads the authorization URL the BFF built and returns
   * the callback query Keycloak would redirect back with. */
  function authorize(location: string, user: FakeUser): { code: string; state: string; params: URLSearchParams } {
    const url = new URL(location)
    const params = url.searchParams
    const code = randomBytes(16).toString('hex')
    codes.set(code, {
      challenge: params.get('code_challenge') ?? '',
      nonce: params.get('nonce') ?? '',
      redirectUri: params.get('redirect_uri') ?? '',
      user,
    })
    return { code, state: params.get('state') ?? '', params }
  }

  return { fetch: fetchImpl, authorize, state, discovery, privateKey, kid }
}

export type FakeKeycloak = ReturnType<typeof createFakeKeycloak>
