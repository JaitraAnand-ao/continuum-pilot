/* The Keycloak OIDC port (realm signin-reports, brokered to Microsoft): authorization code with PKCE S256,
 * state and nonce; the ID token is verified here (RS256 against the realm JWKS) before any session exists. */
import { createPublicKey, verify } from 'node:crypto'
import type { Secret } from '../secret.js'

export interface AuthorizationRequest {
  state: string
  nonce: string
  codeChallenge: string
  maxAge?: number
}

export interface TokenSet {
  idToken: string
  refreshToken: string
}

export interface IdentityClaims {
  account: string
  displayName: string
  roles: unknown
  authTime: Date
}

export interface OidcClient {
  authorizationUrl(request: AuthorizationRequest): Promise<string>
  exchangeCode(code: string, codeVerifier: string): Promise<TokenSet>
  verifyIdToken(idToken: string, nonce: string, now: Date): Promise<IdentityClaims>
  endSession(refreshToken: string): Promise<void>
}

/* Discovery or the JWKS could not be reached: sign-in cannot start (503). */
export class IdpUnavailableError extends Error {
  constructor() {
    super('the identity provider is unavailable')
  }
}

/* The code exchange or the ID token failed verification: the sign-in is refused. */
export class TokenRejectedError extends Error {
  constructor(reason: string) {
    super(`token rejected: ${reason}`)
  }
}

interface Discovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  end_session_endpoint: string
}

export interface KeycloakOidcOptions {
  issuer: string
  clientId: string
  clientSecret: Secret
  redirectUri: string
  idpHint: string
  timeoutMs?: number
}

const CLOCK_SKEW_SECONDS = 60

type Jwk = JsonWebKey & { kid?: string }

export class KeycloakOidcClient implements OidcClient {
  #discovery: Promise<Discovery> | undefined
  readonly #options: KeycloakOidcOptions
  readonly #timeoutMs: number

  constructor(options: KeycloakOidcOptions) {
    this.#options = options
    this.#timeoutMs = options.timeoutMs ?? 5000
  }

  async authorizationUrl(request: AuthorizationRequest): Promise<string> {
    const discovery = await this.#discover()
    const url = new URL(discovery.authorization_endpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.#options.clientId)
    url.searchParams.set('redirect_uri', this.#options.redirectUri)
    url.searchParams.set('scope', 'openid')
    url.searchParams.set('state', request.state)
    url.searchParams.set('nonce', request.nonce)
    url.searchParams.set('code_challenge', request.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('kc_idp_hint', this.#options.idpHint)
    if (request.maxAge !== undefined) url.searchParams.set('max_age', String(request.maxAge))
    return url.toString()
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<TokenSet> {
    const discovery = await this.#discover()
    const body = await this.#postForm(discovery.token_endpoint, {
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      redirect_uri: this.#options.redirectUri,
    }).catch(() => {
      throw new TokenRejectedError('code exchange failed')
    })
    const tokens = (await body.json().catch(() => ({}))) as Record<string, unknown>
    if (!body.ok || typeof tokens.id_token !== 'string' || typeof tokens.refresh_token !== 'string') {
      throw new TokenRejectedError('code exchange failed')
    }
    return { idToken: tokens.id_token, refreshToken: tokens.refresh_token }
  }

  async verifyIdToken(idToken: string, nonce: string, now: Date): Promise<IdentityClaims> {
    const discovery = await this.#discover()
    const [encodedHeader, encodedPayload, encodedSignature] = idToken.split('.')
    if (!encodedHeader || !encodedPayload || encodedSignature === undefined) throw new TokenRejectedError('malformed')
    const header = parseSegment(encodedHeader)
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new TokenRejectedError('algorithm')
    const jwk = await this.#key(discovery, header.kid)
    const signed = verify(
      'sha256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'),
      createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(encodedSignature, 'base64url'),
    )
    if (!signed) throw new TokenRejectedError('signature')

    const claims = parseSegment(encodedPayload)
    const seconds = Math.floor(now.getTime() / 1000)
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (claims.iss !== discovery.issuer) throw new TokenRejectedError('issuer')
    if (!audience.includes(this.#options.clientId)) throw new TokenRejectedError('audience')
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS <= seconds) {
      throw new TokenRejectedError('expired')
    }
    if (typeof claims.nonce !== 'string' || claims.nonce !== nonce) throw new TokenRejectedError('nonce')
    const account = claims.preferred_username ?? claims.upn ?? claims.email
    if (typeof account !== 'string' || !/^\S+@\S+$/.test(account)) throw new TokenRejectedError('account')
    const authTime = typeof claims.auth_time === 'number' ? claims.auth_time : claims.iat
    if (typeof authTime !== 'number') throw new TokenRejectedError('auth_time')
    return {
      account,
      displayName: typeof claims.name === 'string' ? claims.name : account,
      roles: claims.roles,
      authTime: new Date(authTime * 1000),
    }
  }

  /* Ends the Keycloak SSO session behind the refresh token (back-channel logout). */
  async endSession(refreshToken: string): Promise<void> {
    const discovery = await this.#discover()
    const response = await this.#postForm(discovery.end_session_endpoint, { refresh_token: refreshToken })
    if (!response.ok) throw new TokenRejectedError('logout refused')
  }

  #discover(): Promise<Discovery> {
    this.#discovery ??= this.#loadDiscovery().catch((error: unknown) => {
      this.#discovery = undefined
      throw error
    })
    return this.#discovery
  }

  async #loadDiscovery(): Promise<Discovery> {
    const document = await this.#getJson(`${this.#options.issuer}/.well-known/openid-configuration`)
    const fields = ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri', 'end_session_endpoint'] as const
    if (fields.some((field) => typeof document[field] !== 'string') || document.issuer !== this.#options.issuer) {
      throw new IdpUnavailableError()
    }
    return document as unknown as Discovery
  }

  async #key(discovery: Discovery, kid: string): Promise<Jwk> {
    const jwks = await this.#getJson(discovery.jwks_uri)
    const keys = Array.isArray(jwks.keys) ? (jwks.keys as Jwk[]) : []
    const key = keys.find((candidate) => candidate.kid === kid && candidate.kty === 'RSA')
    if (!key) throw new TokenRejectedError('unknown key')
    return key
  }

  async #getJson(url: string): Promise<Record<string, unknown>> {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(this.#timeoutMs) })
      if (!response.ok) throw new IdpUnavailableError()
      return (await response.json()) as Record<string, unknown>
    } catch {
      throw new IdpUnavailableError()
    }
  }

  #postForm(url: string, fields: Record<string, string>): Promise<Response> {
    const body = new URLSearchParams({
      ...fields,
      client_id: this.#options.clientId,
      client_secret: this.#options.clientSecret.reveal(),
    })
    return fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(this.#timeoutMs) })
  }
}

function parseSegment(segment: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    /* fall through to the rejection below */
  }
  throw new TokenRejectedError('malformed')
}
