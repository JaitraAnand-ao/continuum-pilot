import type { AuthorizationRequest, CodeExchange, Identity, OidcClient, SignIn } from '../../src/oidc.js'

/* Stands in for Keycloak at the port: it issues one code per authorization request and checks the PKCE
 * verifier and nonce the BFF presents, the way Keycloak and the ID token validation would. */
export class FakeOidc implements OidcClient {
  readonly authorizations: AuthorizationRequest[] = []
  readonly exchanges: CodeExchange[] = []
  readonly endedSessions: string[] = []
  identity: Identity
  refreshToken: string | null = 'refresh-token-value'
  failAuthorization: Error | undefined
  failSignIn: Error | undefined
  failEndSession: Error | undefined

  constructor(identity: Identity) {
    this.identity = identity
  }

  async authorizationUrl(request: AuthorizationRequest): Promise<string> {
    if (this.failAuthorization) throw this.failAuthorization
    this.authorizations.push(request)
    const url = new URL('https://keycloak.example.test/realms/signin-reports/protocol/openid-connect/auth')
    url.searchParams.set('state', request.state)
    url.searchParams.set('code_challenge', request.codeChallenge)
    return url.toString()
  }

  async completeSignIn(exchange: CodeExchange): Promise<SignIn> {
    if (this.failSignIn) throw this.failSignIn
    this.exchanges.push(exchange)
    return { identity: this.identity, refreshToken: this.refreshToken }
  }

  async endSession(refreshToken: string): Promise<void> {
    if (this.failEndSession) throw this.failEndSession
    this.endedSessions.push(refreshToken)
  }
}

export function identity(overrides: Partial<Identity> = {}): Identity {
  return {
    subject: 'sub-1',
    account: 'm.duarte@contoso.com',
    displayName: 'M. Duarte',
    roles: ['reader'],
    authTime: new Date('2026-10-19T08:00:00.000Z'),
    ...overrides,
  }
}
