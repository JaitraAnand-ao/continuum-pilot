/* A test-only stand-in for the Keycloak realm signin-reports: discovery, JWKS, the token endpoint with a real
 * PKCE S256 check, and the back-channel logout endpoint. ID tokens are RS256-signed with a key made per run. */
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export const CLIENT_ID = 'signin-reports-bff'
export const CLIENT_SECRET = 'test-client-secret'

/* One realm key per test file: RSA generation is too slow to repeat for every test. */
const realmKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })

export interface IssuedCode {
  challenge: string
  nonce: string
  claims: Record<string, unknown>
  refreshToken: string
}

export class FakeKeycloak {
  issuer = ''
  readonly codes = new Map<string, IssuedCode>()
  readonly tokenRequests: URLSearchParams[] = []
  readonly logoutRequests: URLSearchParams[] = []
  readonly endedRefreshTokens: string[] = []
  discoveryAvailable = true
  logoutStatus = 204
  /* Overrides applied to every ID token, for tampering tests (wrong nonce, issuer, audience, expired …). */
  idTokenOverrides: Record<string, unknown> = {}
  idTokenHeaderOverrides: Record<string, unknown> = {}
  signWith: KeyObject | undefined
  nowMs: () => number = () => Date.now()
  readonly #keys = realmKeys
  readonly #server: Server = createServer((request, response) => void this.#handle(request, response))
  #next = 0

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.#server.listen(0, '127.0.0.1', resolve))
    const { port } = this.#server.address() as AddressInfo
    this.issuer = `http://127.0.0.1:${port}/realms/signin-reports`
    return this
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections()
    await new Promise<void>((resolve) => this.#server.close(() => resolve()))
  }

  /* What Keycloak does after the browser completes Microsoft sign-in: binds a code to the request's challenge and nonce. */
  issueCode(authorizeUrl: string, claims: Record<string, unknown>): { code: string; state: string } {
    const url = new URL(authorizeUrl)
    const code = `code-${++this.#next}`
    this.codes.set(code, {
      challenge: url.searchParams.get('code_challenge') ?? '',
      nonce: url.searchParams.get('nonce') ?? '',
      claims,
      refreshToken: `refresh-token-${this.#next}-secret-value`,
    })
    return { code, state: url.searchParams.get('state') ?? '' }
  }

  idToken(payload: Record<string, unknown>, header: Record<string, unknown> = {}): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const signingInput = `${encode({ alg: 'RS256', typ: 'JWT', kid: 'test-key', ...header })}.${encode(payload)}`
    const signature = sign('sha256', Buffer.from(signingInput), this.signWith ?? this.#keys.privateKey)
    return `${signingInput}.${signature.toString('base64url')}`
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', this.issuer).pathname
    const realm = new URL(this.issuer).pathname
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (path === `${realm}/.well-known/openid-configuration`) {
      if (!this.discoveryAvailable) return json(503, {})
      return json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/protocol/openid-connect/auth`,
        token_endpoint: `${this.issuer}/protocol/openid-connect/token`,
        jwks_uri: `${this.issuer}/protocol/openid-connect/certs`,
        end_session_endpoint: `${this.issuer}/protocol/openid-connect/logout`,
      })
    }
    if (path === `${realm}/protocol/openid-connect/certs`) {
      const jwk = this.#keys.publicKey.export({ format: 'jwk' })
      return json(200, {
        keys: [
          { kty: 'EC', kid: 'other' },
          { ...jwk, kid: 'test-key', use: 'sig', alg: 'RS256' },
        ],
      })
    }
    const form = new URLSearchParams(await readBody(request))
    const clientOk = form.get('client_id') === CLIENT_ID && form.get('client_secret') === CLIENT_SECRET
    if (path === `${realm}/protocol/openid-connect/token`) {
      this.tokenRequests.push(form)
      const issued = this.codes.get(form.get('code') ?? '')
      const verifier = form.get('code_verifier') ?? ''
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      if (!clientOk || !issued || issued.challenge !== challenge) return json(400, { error: 'invalid_grant' })
      this.codes.delete(form.get('code') ?? '')
      const now = Math.floor(this.nowMs() / 1000)
      const idToken = this.idToken(
        {
          iss: this.issuer,
          aud: CLIENT_ID,
          iat: now,
          exp: now + 300,
          nonce: issued.nonce,
          ...issued.claims,
          ...this.idTokenOverrides,
        },
        this.idTokenHeaderOverrides,
      )
      return json(200, {
        access_token: 'access-token-secret-value',
        id_token: idToken,
        refresh_token: issued.refreshToken,
        token_type: 'Bearer',
      })
    }
    if (path === `${realm}/protocol/openid-connect/logout`) {
      this.logoutRequests.push(form)
      if (!clientOk) return json(401, {})
      this.endedRefreshTokens.push(form.get('refresh_token') ?? '')
      response.writeHead(this.logoutStatus)
      return void response.end()
    }
    json(404, {})
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
    request.on('end', () => resolve(body))
  })
}
