/* IF-10 and IF-11: the BFF's only conversation with Keycloak (realm signin-reports). Authorization code flow
 * with PKCE S256, state and nonce; ID tokens are verified here (RS256 against the realm JWKS) and the tokens
 * never leave the server. */
import { createPublicKey, verify, type JsonWebKeyInput } from 'node:crypto'
import { z } from 'zod'
import type { Clock } from '../clock.js'
import type { Secret } from '../config.js'

const CLOCK_SKEW_S = 30
const TIMEOUT_MS = 5000

/** Keycloak could not be reached or answered with a server error. */
export class IdentityProviderUnavailable extends Error {}
/** The token endpoint refused the code exchange (bad code, PKCE verifier or client). */
export class TokenExchangeRejected extends Error {}
/** The ID token failed signature, issuer, audience, expiry, nonce or auth_time checks. */
export class IdTokenInvalid extends Error {}

export interface AuthorizationRequest {
  redirectUri: string
  state: string
  nonce: string
  codeChallenge: string
  idpHint: string
  maxAge?: number | undefined
}

export interface TokenSet {
  idToken: string
  refreshToken: string
}

export interface OidcClient {
  authorizationUrl(request: AuthorizationRequest): Promise<string>
  exchangeCode(exchange: { code: string; codeVerifier: string; redirectUri: string }): Promise<TokenSet>
  verifyIdToken(
    idToken: string,
    expected: { nonce: string; maxAge?: number | undefined },
  ): Promise<Record<string, unknown>>
  endSession(refreshToken: string): Promise<void>
}

export interface OidcClientOptions {
  issuer: string
  clientId: string
  clientSecret: Secret<string>
  clock: Clock
  fetch?: typeof fetch
}

const discoverySchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
  end_session_endpoint: z.url(),
})
type Discovery = z.infer<typeof discoverySchema>

const tokenSchema = z.object({ id_token: z.string().min(1), refresh_token: z.string().min(1) })
const jwksSchema = z.object({ keys: z.array(z.looseObject({ kid: z.string().optional(), kty: z.string() })) })
const headerSchema = z.object({ alg: z.string(), kid: z.string().optional() })
const claimsSchema = z.looseObject({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  azp: z.string().optional(),
  exp: z.number(),
  auth_time: z.number(),
  nonce: z.string(),
})

function decodeJson(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
  } catch {
    throw new IdTokenInvalid('malformed segment')
  }
}

export function createOidcClient(options: OidcClientOptions): OidcClient {
  const doFetch = options.fetch ?? fetch
  let discovery: Discovery | undefined
  let jwks: Map<string, JsonWebKeyInput['key']> | undefined

  async function call(url: string, init: RequestInit = {}): Promise<Response> {
    let response: Response
    try {
      response = await doFetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch {
      throw new IdentityProviderUnavailable('Keycloak is unreachable')
    }
    if (response.status >= 500) throw new IdentityProviderUnavailable(`Keycloak answered ${response.status}`)
    return response
  }

  async function discover(): Promise<Discovery> {
    if (discovery !== undefined) return discovery
    const response = await call(`${options.issuer}/.well-known/openid-configuration`)
    const parsed = discoverySchema.safeParse(response.ok ? await response.json() : undefined)
    if (!parsed.success || parsed.data.issuer !== options.issuer) {
      throw new IdentityProviderUnavailable('Keycloak discovery is unusable')
    }
    discovery = parsed.data
    return discovery
  }

  async function signingKey(kid: string | undefined): Promise<JsonWebKeyInput['key'] | undefined> {
    const find = () => (kid === undefined ? undefined : jwks?.get(kid))
    if (find() === undefined) {
      const response = await call((await discover()).jwks_uri)
      const parsed = jwksSchema.safeParse(response.ok ? await response.json() : undefined)
      if (!parsed.success) throw new IdentityProviderUnavailable('Keycloak JWKS is unusable')
      jwks = new Map(
        parsed.data.keys.flatMap((key) => (key.kid === undefined ? [] : [[key.kid, key as JsonWebKeyInput['key']]])),
      )
    }
    return find()
  }

  const form = (fields: Record<string, string>): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })

  return {
    async authorizationUrl(request) {
      const url = new URL((await discover()).authorization_endpoint)
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: options.clientId,
        redirect_uri: request.redirectUri,
        scope: 'openid profile',
        state: request.state,
        nonce: request.nonce,
        code_challenge: request.codeChallenge,
        code_challenge_method: 'S256',
        kc_idp_hint: request.idpHint,
        ...(request.maxAge === undefined ? {} : { max_age: String(request.maxAge) }),
      }).toString()
      return url.toString()
    },

    async exchangeCode(exchange) {
      const response = await call(
        (await discover()).token_endpoint,
        form({
          grant_type: 'authorization_code',
          code: exchange.code,
          redirect_uri: exchange.redirectUri,
          code_verifier: exchange.codeVerifier,
          client_id: options.clientId,
          client_secret: options.clientSecret.reveal(),
        }),
      )
      if (!response.ok) throw new TokenExchangeRejected(`token endpoint answered ${response.status}`)
      const parsed = tokenSchema.safeParse(await response.json())
      if (!parsed.success) throw new TokenExchangeRejected('token response lacks the ID or refresh token')
      return { idToken: parsed.data.id_token, refreshToken: parsed.data.refresh_token }
    },

    async verifyIdToken(idToken, expected) {
      const [header, payload, signature, ...rest] = idToken.split('.')
      if (header === undefined || payload === undefined || signature === undefined || rest.length > 0) {
        throw new IdTokenInvalid('not a JWS')
      }
      const parsedHeader = headerSchema.safeParse(decodeJson(header))
      if (!parsedHeader.success || parsedHeader.data.alg !== 'RS256') throw new IdTokenInvalid('alg must be RS256')
      const jwk = await signingKey(parsedHeader.data.kid)
      if (jwk === undefined) throw new IdTokenInvalid('unknown signing key')
      const signedInput = Buffer.from(`${header}.${payload}`)
      if (
        !verify(
          'sha256',
          signedInput,
          createPublicKey({ key: jwk, format: 'jwk' }),
          Buffer.from(signature, 'base64url'),
        )
      ) {
        throw new IdTokenInvalid('bad signature')
      }
      const parsed = claimsSchema.safeParse(decodeJson(payload))
      if (!parsed.success) throw new IdTokenInvalid('required claims are missing')
      const claims = parsed.data
      const now = options.clock.now().getTime() / 1000
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
      if (claims.iss !== options.issuer) throw new IdTokenInvalid('wrong issuer')
      if (!audiences.includes(options.clientId)) throw new IdTokenInvalid('wrong audience')
      if (audiences.length > 1 && claims.azp !== options.clientId) throw new IdTokenInvalid('wrong authorized party')
      if (now >= claims.exp + CLOCK_SKEW_S) throw new IdTokenInvalid('expired')
      if (claims.nonce !== expected.nonce) throw new IdTokenInvalid('nonce mismatch')
      if (expected.maxAge !== undefined && now - claims.auth_time > expected.maxAge + CLOCK_SKEW_S) {
        throw new IdTokenInvalid('authentication is older than max_age')
      }
      return claims
    },

    async endSession(refreshToken) {
      const response = await call(
        (await discover()).end_session_endpoint,
        form({
          client_id: options.clientId,
          client_secret: options.clientSecret.reveal(),
          refresh_token: refreshToken,
        }),
      )
      if (!response.ok) throw new IdentityProviderUnavailable(`logout answered ${response.status}`)
    },
  }
}
