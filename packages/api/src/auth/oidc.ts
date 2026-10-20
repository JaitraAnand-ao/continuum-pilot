/* The Keycloak signin-reports realm as an OIDC provider: discovery and keys (IF-10), token and logout (IF-11).
 * Confidential client with client_secret_post; ID tokens are verified here (RS256, iss, aud/azp, exp, iat, nonce). */
import { createPublicKey, verify } from 'node:crypto'
import type { Clock } from '../clock.js'
import type { Secret } from '../config.js'

/* Keycloak cannot be reached or answered unusably: the user may try again later. */
export class OidcUnavailableError extends Error {}
/* Keycloak or its token refused this login: the code, PKCE verifier, nonce or signature did not hold. */
export class OidcRejectedError extends Error {}

export interface IdTokenClaims {
  iss: string
  sub: string
  aud: string | string[]
  exp: number
  iat: number
  nonce?: string
  auth_time?: number
  upn?: string
  preferred_username?: string
  name?: string
  roles?: unknown
  [claim: string]: unknown
}

export interface CodeExchange {
  claims: IdTokenClaims
  refreshToken: string | undefined
}

export interface OidcClient {
  authorizationUrl(params: { state: string; nonce: string; codeChallenge: string; maxAge?: number }): Promise<string>
  exchangeCode(params: { code: string; codeVerifier: string; nonce: string }): Promise<CodeExchange>
  endSession(refreshToken: string): Promise<void>
}

export interface OidcClientOptions {
  issuer: string
  clientId: string
  clientSecret: Secret<string>
  redirectUri: string
  idpHint: string
  fetch: typeof fetch
  clock: Clock
}

interface Discovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  end_session_endpoint: string
}

const ALLOWED_CLOCK_SKEW_S = 60

function isDiscovery(value: unknown, issuer: string): value is Discovery {
  if (typeof value !== 'object' || value === null) return false
  const doc = value as Record<string, unknown>
  return (
    doc.issuer === issuer &&
    ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'end_session_endpoint'].every(
      (key) => typeof doc[key] === 'string',
    )
  )
}

function decodeSegment(segment: string): Record<string, unknown> {
  const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
  if (typeof value !== 'object' || value === null) throw new OidcRejectedError('ID token segment is not an object')
  return value as Record<string, unknown>
}

export function createOidcClient(options: OidcClientOptions): OidcClient {
  let discovery: Discovery | undefined
  let keys = new Map<string, JsonWebKey>()

  async function call(url: string, init?: RequestInit): Promise<Response> {
    try {
      return await options.fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
    } catch {
      throw new OidcUnavailableError('Keycloak could not be reached')
    }
  }

  async function discover(): Promise<Discovery> {
    if (discovery) return discovery
    const response = await call(`${options.issuer}/.well-known/openid-configuration`)
    const body: unknown = response.ok ? await response.json().catch(() => undefined) : undefined
    if (!isDiscovery(body, options.issuer)) throw new OidcUnavailableError('Keycloak discovery is unavailable')
    discovery = body
    return body
  }

  async function refreshKeys(): Promise<void> {
    const { jwks_uri } = await discover()
    const response = await call(jwks_uri)
    const body = (await response.json().catch(() => ({}))) as { keys?: Array<JsonWebKey & { kid?: string }> }
    keys = new Map((body.keys ?? []).filter((key) => typeof key.kid === 'string').map((key) => [key.kid!, key]))
  }

  async function signingKey(kid: string): Promise<JsonWebKey> {
    if (!keys.has(kid)) await refreshKeys()
    const key = keys.get(kid)
    if (!key) throw new OidcRejectedError('ID token signed with an unknown key')
    return key
  }

  function form(fields: Record<string, string>): RequestInit {
    return {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...fields,
        client_id: options.clientId,
        client_secret: options.clientSecret.reveal(),
      }).toString(),
    }
  }

  async function verifyIdToken(idToken: unknown, nonce: string): Promise<IdTokenClaims> {
    if (typeof idToken !== 'string') throw new OidcRejectedError('no ID token')
    const parts = idToken.split('.')
    if (parts.length !== 3) throw new OidcRejectedError('ID token is not a JWS')
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string]
    let header: Record<string, unknown>
    try {
      header = decodeSegment(encodedHeader)
    } catch {
      throw new OidcRejectedError('ID token header is unreadable')
    }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
      throw new OidcRejectedError('ID token is not RS256 with a key ID')
    }
    const jwk = await signingKey(header.kid)
    const signed = verify(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(encodedSignature, 'base64url'),
    )
    if (!signed) throw new OidcRejectedError('ID token signature does not verify')
    let claims: Record<string, unknown>
    try {
      claims = decodeSegment(encodedPayload)
    } catch {
      throw new OidcRejectedError('ID token payload is unreadable')
    }
    const now = Math.floor(options.clock.now().getTime() / 1000)
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    const problems = [
      claims.iss !== options.issuer && 'issuer',
      !audiences.includes(options.clientId) && 'audience',
      audiences.length > 1 && claims.azp !== options.clientId && 'authorized party',
      (typeof claims.exp !== 'number' || claims.exp <= now) && 'expiry',
      (typeof claims.iat !== 'number' || claims.iat > now + ALLOWED_CLOCK_SKEW_S) && 'issued-at',
      (typeof claims.sub !== 'string' || claims.sub === '') && 'subject',
      claims.nonce !== nonce && 'nonce',
    ].filter(Boolean)
    if (problems.length > 0) throw new OidcRejectedError(`ID token ${problems.join(', ')} invalid`)
    return claims as IdTokenClaims
  }

  return {
    async authorizationUrl({ state, nonce, codeChallenge, maxAge }) {
      const { authorization_endpoint } = await discover()
      const url = new URL(authorization_endpoint)
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: options.clientId,
        redirect_uri: options.redirectUri,
        scope: 'openid profile email',
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        kc_idp_hint: options.idpHint,
        ...(maxAge === undefined ? {} : { max_age: String(maxAge) }),
      }).toString()
      return url.href
    },

    async exchangeCode({ code, codeVerifier, nonce }) {
      const { token_endpoint } = await discover()
      const response = await call(
        token_endpoint,
        form({
          grant_type: 'authorization_code',
          code,
          redirect_uri: options.redirectUri,
          code_verifier: codeVerifier,
        }),
      )
      if (response.status >= 500) throw new OidcUnavailableError('Keycloak token endpoint is unavailable')
      if (!response.ok) throw new OidcRejectedError(`Keycloak refused the code (${response.status})`)
      const body = (await response.json().catch(() => ({}))) as { id_token?: unknown; refresh_token?: unknown }
      const claims = await verifyIdToken(body.id_token, nonce)
      return { claims, refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined }
    },

    async endSession(refreshToken) {
      const { end_session_endpoint } = await discover()
      const response = await call(end_session_endpoint, form({ refresh_token: refreshToken }))
      if (!response.ok) throw new OidcUnavailableError(`Keycloak logout failed (${response.status})`)
    },
  }
}
