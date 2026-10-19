/* The OIDC port the routes depend on. The Keycloak adapter implements it; tests use a fake. */
import type { Role } from './roles.js'

export interface AuthorizationRequest {
  state: string
  nonce: string
  codeChallenge: string
  redirectUri: string
  maxAge?: number
}

export interface CodeExchange {
  code: string
  codeVerifier: string
  redirectUri: string
  nonce: string
}

export interface Identity {
  subject: string
  account: string
  displayName: string
  roles: Role[]
  authTime: Date
}

export interface SignIn {
  identity: Identity
  refreshToken: string | null
}

export interface OidcClient {
  authorizationUrl(request: AuthorizationRequest): Promise<string>
  /* Exchanges the code with its PKCE verifier and validates the ID token, nonce included. */
  completeSignIn(exchange: CodeExchange): Promise<SignIn>
  /* Ends the Keycloak session the refresh token belongs to. */
  endSession(refreshToken: string): Promise<void>
}

/* Keycloak could not be reached or answered something unusable. */
export class OidcUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OidcUnavailableError'
  }
}

/* Keycloak refused the exchange, or the token failed validation. */
export class OidcRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OidcRejectedError'
  }
}
