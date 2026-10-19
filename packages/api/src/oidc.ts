/* OIDC client for the Keycloak realm signin-reports (consumes IF-10 discovery/JWKS and IF-11 token).
 * Authorization code flow with PKCE S256, state and nonce; ID tokens are verified here, RS256 only. */
import { createPublicKey, verify, type webcrypto } from 'node:crypto'
import type { Clock } from './clock'
import type { Secret } from './config'
import { safeEqual } from './crypto'

const CLOCK_SKEW_MS = 60 * 1000

export class OidcUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('identity provider unavailable', { cause })
    this.name = 'OidcUnavailableError'
  }
}

export class OidcRejectedError extends Error {
  constructor(reason: string) {
    super(`identity provider response rejected: ${reason}`)
    this.name = 'OidcRejectedError'
  }
}

export interface IdTokenClaims {
  iss: string
  sub: string
  aud: string | string[]
  exp: number
  iat: number
  nonce: string
  auth_time?: number
  preferred_username?: string
  name?: string
  roles?: unknown
}

export interface OidcTokens {
  idToken: string
  refreshToken: string | undefined
  claims: IdTokenClaims
}

export interface AuthorizationRequest {
  state: string
  nonce: string
  codeChallenge: string
  redirectUri: string
  maxAge?: number | undefined
}

export interface OidcClient {
  authorizationUrl(request: AuthorizationRequest): Promise<string>
  exchangeCode(request: { code: string; codeVerifier: string; redirectUri: string; nonce: string }): Promise<OidcTokens>
  verifyIdToken(idToken: string, nonce: string): Promise<IdTokenClaims>
  endSessionUrl(request: { idToken: string; postLogoutRedirectUri: string }): Promise<string>
}

interface Discovery {
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  end_session_endpoint: string
}

export interface KeycloakClientOptions {
  issuer: string
  clientId: string
  clientSecret: Secret<string>
  clock: Clock
  fetch?: typeof fetch
}

export function createKeycloakClient({
  issuer,
  clientId,
  clientSecret,
  clock,
  fetch: fetchImpl = fetch,
}: KeycloakClientOptions): OidcClient {
  let discovery: Discovery | undefined

  const getJson = async (url: string): Promise<unknown> => {
    let response: Response
    try {
      response = await fetchImpl(url, { headers: { accept: 'application/json' } })
    } catch (problem) {
      throw new OidcUnavailableError(problem)
    }
    if (!response.ok) throw new OidcUnavailableError(`HTTP ${response.status}`)
    return response.json()
  }

  const discover = async (): Promise<Discovery> => {
    discovery ??= (await getJson(`${issuer}/.well-known/openid-configuration`)) as Discovery
    return discovery
  }

  const signingKey = async (kid: unknown): Promise<webcrypto.JsonWebKey> => {
    const { keys } = (await getJson((await discover()).jwks_uri)) as {
      keys: (webcrypto.JsonWebKey & { kid?: string })[]
    }
    const key = keys.find((candidate) => candidate.kid === kid)
    if (key === undefined) throw new OidcRejectedError('unknown signing key')
    return key
  }

  const decodePart = (part: string): Record<string, unknown> => {
    try {
      return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
    } catch {
      throw new OidcRejectedError('malformed token')
    }
  }

  const verifyIdToken = async (idToken: string, nonce: string): Promise<IdTokenClaims> => {
    const parts = idToken.split('.')
    if (parts.length !== 3) throw new OidcRejectedError('malformed token')
    const [head = '', body = '', signature = ''] = parts
    const header = decodePart(head)
    if (header.alg !== 'RS256') throw new OidcRejectedError('unexpected algorithm')
    const key = createPublicKey({ key: await signingKey(header.kid), format: 'jwk' })
    if (!verify('sha256', Buffer.from(`${head}.${body}`), key, Buffer.from(signature, 'base64url'))) {
      throw new OidcRejectedError('bad signature')
    }
    const claims = decodePart(body) as unknown as IdTokenClaims
    const now = clock.now().getTime()
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (claims.iss !== issuer) throw new OidcRejectedError('issuer')
    if (!audiences.includes(clientId)) throw new OidcRejectedError('audience')
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) throw new OidcRejectedError('expired')
    if (typeof claims.iat !== 'number' || claims.iat * 1000 > now + CLOCK_SKEW_MS) {
      throw new OidcRejectedError('issued in the future')
    }
    if (typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, nonce)) throw new OidcRejectedError('nonce')
    return claims
  }

  return {
    async authorizationUrl({ state, nonce, codeChallenge, redirectUri, maxAge }) {
      const url = new URL((await discover()).authorization_endpoint)
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: 'openid profile email',
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        kc_idp_hint: 'microsoft',
        ...(maxAge === undefined ? {} : { max_age: String(maxAge) }),
      }).toString()
      return url.toString()
    },

    async exchangeCode({ code, codeVerifier, redirectUri, nonce }) {
      const { token_endpoint } = await discover()
      let response: Response
      try {
        response = await fetchImpl(token_endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            client_secret: clientSecret.reveal(),
            code_verifier: codeVerifier,
          }),
        })
      } catch (problem) {
        throw new OidcUnavailableError(problem)
      }
      if (!response.ok) throw new OidcRejectedError(`token endpoint answered ${response.status}`)
      const tokens = (await response.json()) as { id_token?: unknown; refresh_token?: unknown }
      if (typeof tokens.id_token !== 'string') throw new OidcRejectedError('no ID token')
      return {
        idToken: tokens.id_token,
        refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : undefined,
        claims: await verifyIdToken(tokens.id_token, nonce),
      }
    },

    verifyIdToken,

    async endSessionUrl({ idToken, postLogoutRedirectUri }) {
      const url = new URL((await discover()).end_session_endpoint)
      url.search = new URLSearchParams({
        id_token_hint: idToken,
        client_id: clientId,
        post_logout_redirect_uri: postLogoutRedirectUri,
      }).toString()
      return url.toString()
    },
  }
}
