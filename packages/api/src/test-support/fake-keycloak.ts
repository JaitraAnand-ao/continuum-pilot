/* Test-only stand-in for the Keycloak realm signin-reports (IF-10 discovery and JWKS, IF-11 token and logout).
 * It speaks real HTTP on an ephemeral port, signs ID tokens with a key generated per run, and enforces
 * PKCE S256, one-time codes and the client secret the way Keycloak does. */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import Fastify from 'fastify'

export interface IssuedCode {
  claims: Record<string, unknown>
  nonce: string
  codeChallenge: string
  redirectUri: string
}

export interface FakeKeycloak {
  issuer: string
  clientId: string
  clientSecret: string
  /** Set to make discovery answer 503. */
  discoveryDown: boolean
  /** Set to make the token endpoint answer 503. */
  tokenEndpointDown: boolean
  /** Set to sign ID tokens with a key that is not in the JWKS. */
  signWithRogueKey: boolean
  /** Overrides merged into the next ID token's claims (for iss, aud, exp and nonce tampering). */
  idTokenOverrides: Record<string, unknown>
  /** Overrides the JWS header alg of issued ID tokens. */
  idTokenAlg: string
  issueCode(code: IssuedCode): string
  readonly tokenRequests: Record<string, string>[]
  readonly logoutRequests: Record<string, string>[]
  /** Refresh tokens the token endpoint has handed out, in order. */
  readonly refreshTokens: string[]
  close(): Promise<void>
}

const base64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url')

function signJwt(header: Record<string, unknown>, claims: Record<string, unknown>, key: KeyObject): string {
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
  return `${signingInput}.${base64url(sign('sha256', Buffer.from(signingInput), key))}`
}

/* generated once per test file: RSA key generation is the slow part of starting a fake */
const realKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
const rogueKey = generateKeyPairSync('rsa', { modulusLength: 2048 })

export async function startFakeKeycloak(now: () => Date): Promise<FakeKeycloak> {
  const kid = 'kc-test-key'
  const codes = new Map<string, IssuedCode>()
  const server = Fastify()
  server.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)))
  })

  const fake: FakeKeycloak = {
    issuer: '',
    clientId: 'signin-reports-bff',
    clientSecret: 'test-only-client-secret',
    discoveryDown: false,
    tokenEndpointDown: false,
    signWithRogueKey: false,
    idTokenOverrides: {},
    idTokenAlg: 'RS256',
    tokenRequests: [],
    logoutRequests: [],
    refreshTokens: [],
    issueCode(code) {
      const value = randomBytes(16).toString('hex')
      codes.set(value, code)
      return value
    },
    close: () => server.close(),
  }

  const realmPath = '/realms/signin-reports'
  server.get(`${realmPath}/.well-known/openid-configuration`, async (_request, reply) => {
    if (fake.discoveryDown) return reply.code(503).send({ error: 'unavailable' })
    return {
      issuer: fake.issuer,
      authorization_endpoint: `${fake.issuer}/protocol/openid-connect/auth`,
      token_endpoint: `${fake.issuer}/protocol/openid-connect/token`,
      jwks_uri: `${fake.issuer}/protocol/openid-connect/certs`,
      end_session_endpoint: `${fake.issuer}/protocol/openid-connect/logout`,
    }
  })
  server.get(`${realmPath}/protocol/openid-connect/certs`, async () => ({
    keys: [{ ...realKey.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }],
  }))
  server.post(`${realmPath}/protocol/openid-connect/token`, async (request, reply) => {
    const form = request.body as Record<string, string>
    fake.tokenRequests.push(form)
    if (fake.tokenEndpointDown) return reply.code(503).send({ error: 'unavailable' })
    if (form.client_id !== fake.clientId || form.client_secret !== fake.clientSecret) {
      return reply.code(401).send({ error: 'unauthorized_client' })
    }
    const issued = form.code === undefined ? undefined : codes.get(form.code)
    if (form.grant_type !== 'authorization_code' || issued === undefined) {
      return reply.code(400).send({ error: 'invalid_grant' })
    }
    codes.delete(form.code as string)
    const challenge = createHash('sha256')
      .update(form.code_verifier ?? '')
      .digest('base64url')
    if (challenge !== issued.codeChallenge || form.redirect_uri !== issued.redirectUri) {
      return reply.code(400).send({ error: 'invalid_grant', error_description: 'PKCE verification failed' })
    }
    const issuedAt = Math.floor(now().getTime() / 1000)
    const claims = {
      iss: fake.issuer,
      aud: fake.clientId,
      azp: fake.clientId,
      sub: randomBytes(8).toString('hex'),
      iat: issuedAt,
      exp: issuedAt + 300,
      auth_time: issuedAt,
      nonce: issued.nonce,
      ...issued.claims,
      ...fake.idTokenOverrides,
    }
    const key = fake.signWithRogueKey ? rogueKey.privateKey : realKey.privateKey
    const refreshToken = `rt-${randomBytes(24).toString('hex')}`
    fake.refreshTokens.push(refreshToken)
    return {
      token_type: 'Bearer',
      expires_in: 300,
      access_token: `at-${randomBytes(24).toString('hex')}`,
      refresh_token: refreshToken,
      id_token: signJwt({ alg: fake.idTokenAlg, typ: 'JWT', kid }, claims, key),
    }
  })
  server.post(`${realmPath}/protocol/openid-connect/logout`, async (request, reply) => {
    fake.logoutRequests.push(request.body as Record<string, string>)
    return reply.code(204).send()
  })

  const address = await server.listen({ host: '127.0.0.1', port: 0 })
  fake.issuer = `${address}${realmPath}`
  return fake
}
