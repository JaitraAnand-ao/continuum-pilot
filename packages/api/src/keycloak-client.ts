/* The Keycloak adapter of the OIDC port: discovery, PKCE code exchange, RS256 ID token validation against the
 * realm's JWKS, and back-channel logout. Microsoft is reached only through Keycloak (kc_idp_hint). */
import { createPublicKey, verify } from 'node:crypto'
import type { Clock } from './clock.js'
import {
  OidcRejectedError,
  OidcUnavailableError,
  type AuthorizationRequest,
  type CodeExchange,
  type OidcClient,
  type SignIn,
} from './oidc.js'
import { rolesFromClaim } from './roles.js'
import type { Secret } from './secret.js'

export interface KeycloakClientOptions {
  issuer: string
  clientId: string
  clientSecret: Secret
  clock: Clock
  fetch: typeof globalThis.fetch
  identityProviderHint?: string
}

interface Discovery {
  authorization_endpoint: string
  token_endpoint: string
  end_session_endpoint: string
  jwks_uri: string
}

const CLOCK_SKEW_S = 60

function isDiscovery(value: unknown): value is Discovery {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return ['authorization_endpoint', 'token_endpoint', 'end_session_endpoint', 'jwks_uri'].every(
    (key) => typeof record[key] === 'string',
  )
}

function decodeSegment(segment: string | undefined): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment ?? '', 'base64url').toString('utf8'))
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    /* fall through to the rejection below */
  }
  throw new OidcRejectedError('ID token is malformed')
}

export function createKeycloakClient(options: KeycloakClientOptions): OidcClient {
  const hint = options.identityProviderHint ?? 'microsoft'
  let discovery: Promise<Discovery> | undefined
  let keys = new Map<string, JsonWebKey>()

  async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
    let response: Response
    try {
      response = await options.fetch(url, { ...init, signal: AbortSignal.timeout(5000) })
    } catch {
      throw new OidcUnavailableError('Keycloak is unreachable')
    }
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      /* a body that is not JSON is judged by its status alone */
    }
    return { status: response.status, body }
  }

  function discover(): Promise<Discovery> {
    discovery ??= (async () => {
      const { status, body } = await getJson(`${options.issuer}/.well-known/openid-configuration`)
      if (status !== 200 || !isDiscovery(body)) throw new OidcUnavailableError('Keycloak discovery is unusable')
      return body
    })()
    /* A failed discovery is retried on the next call instead of being cached. */
    discovery.catch(() => {
      discovery = undefined
    })
    return discovery
  }

  async function loadKeys(): Promise<void> {
    const { jwks_uri } = await discover()
    const { status, body } = await getJson(jwks_uri)
    const list = (body as { keys?: unknown } | null)?.keys
    if (status !== 200 || !Array.isArray(list)) throw new OidcUnavailableError('Keycloak JWKS is unusable')
    keys = new Map(
      (list as (JsonWebKey & { kid?: unknown })[])
        .filter((key) => typeof key.kid === 'string' && key.kty === 'RSA')
        .map((key) => [key.kid as string, key]),
    )
  }

  async function keyFor(kid: string): Promise<JsonWebKey> {
    if (!keys.has(kid)) await loadKeys()
    const key = keys.get(kid)
    if (key === undefined) throw new OidcRejectedError('ID token is signed with an unknown key')
    return key
  }

  async function validateIdToken(idToken: string, nonce: string): Promise<Record<string, unknown>> {
    const parts = idToken.split('.')
    if (parts.length !== 3) throw new OidcRejectedError('ID token is malformed')
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]
    const header = decodeSegment(headerPart)
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
      throw new OidcRejectedError('ID token algorithm is not accepted')
    }
    const key = createPublicKey({ key: await keyFor(header.kid), format: 'jwk' })
    const signed = Buffer.from(`${headerPart}.${payloadPart}`)
    if (!verify('sha256', signed, key, Buffer.from(signaturePart, 'base64url'))) {
      throw new OidcRejectedError('ID token signature is invalid')
    }
    const claims = decodeSegment(payloadPart)
    const now = options.clock.now().getTime() / 1000
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (claims.iss !== options.issuer) throw new OidcRejectedError('ID token issuer is wrong')
    if (!audience.includes(options.clientId)) throw new OidcRejectedError('ID token audience is wrong')
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S <= now) {
      throw new OidcRejectedError('ID token has expired')
    }
    if (claims.nonce !== nonce) throw new OidcRejectedError('ID token nonce does not match')
    return claims
  }

  return {
    async authorizationUrl(request: AuthorizationRequest): Promise<string> {
      const { authorization_endpoint } = await discover()
      const url = new URL(authorization_endpoint)
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: options.clientId,
        redirect_uri: request.redirectUri,
        scope: 'openid profile',
        state: request.state,
        nonce: request.nonce,
        code_challenge: request.codeChallenge,
        code_challenge_method: 'S256',
        kc_idp_hint: hint,
        ...(request.maxAge === undefined ? {} : { max_age: String(request.maxAge) }),
      }).toString()
      return url.toString()
    },

    async completeSignIn(exchange: CodeExchange): Promise<SignIn> {
      const { token_endpoint } = await discover()
      const { status, body } = await getJson(token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: exchange.code,
          code_verifier: exchange.codeVerifier,
          redirect_uri: exchange.redirectUri,
          client_id: options.clientId,
          client_secret: options.clientSecret.reveal(),
        }).toString(),
      })
      if (status >= 500) throw new OidcUnavailableError('Keycloak token endpoint failed')
      const tokens = body as { id_token?: unknown; refresh_token?: unknown } | null
      if (status !== 200 || typeof tokens?.id_token !== 'string') {
        throw new OidcRejectedError('Keycloak refused the authorization code')
      }
      const claims = await validateIdToken(tokens.id_token, exchange.nonce)
      const account = [claims.upn, claims.preferred_username, claims.email].find(
        (value): value is string => typeof value === 'string' && value.length > 0,
      )
      if (typeof claims.sub !== 'string' || account === undefined) {
        throw new OidcRejectedError('ID token names no account')
      }
      const authTime = typeof claims.auth_time === 'number' ? claims.auth_time : now(options.clock)
      return {
        identity: {
          subject: claims.sub,
          account,
          displayName: typeof claims.name === 'string' ? claims.name : account,
          roles: rolesFromClaim(claims.roles),
          authTime: new Date(authTime * 1000),
        },
        refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : null,
      }
    },

    async endSession(refreshToken: string): Promise<void> {
      const { end_session_endpoint } = await discover()
      const { status } = await getJson(end_session_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: options.clientId,
          client_secret: options.clientSecret.reveal(),
          refresh_token: refreshToken,
        }).toString(),
      })
      if (status < 200 || status >= 300) throw new OidcUnavailableError('Keycloak logout failed')
    },
  }
}

function now(clock: Clock): number {
  return Math.floor(clock.now().getTime() / 1000)
}
