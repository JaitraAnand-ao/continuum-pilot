/* Test-only stand-in for the Keycloak realm signin-reports (IF-10 discovery and JWKS, IF-11 token endpoint).
 * It signs ID tokens with a throwaway RSA key and enforces PKCE S256 the way Keycloak does. */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'

export interface IssuedCode {
  challenge: string
  claims: Record<string, unknown>
}

export interface FakeKeycloak {
  readonly issuer: string
  clientId: string
  clientSecret: string
  issueCode(code: IssuedCode): string
  signIdToken(claims: Record<string, unknown>, header?: Record<string, unknown>): string
  tokenRequests: Record<string, string>[]
  failDiscovery: boolean
  failToken: boolean
  close(): Promise<void>
}

const base64url = (input: Buffer | string) => Buffer.from(input).toString('base64url')

export async function startFakeKeycloak(): Promise<FakeKeycloak> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const kid = 'test-key'
  const codes = new Map<string, IssuedCode>()
  const server: FastifyInstance = Fastify()
  server.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)))
  })
  let issuer = ''
  const realm = '/realms/signin-reports'

  const signWith = (key: KeyObject, claims: Record<string, unknown>, header: Record<string, unknown>) => {
    const head = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid, ...header }))
    const body = base64url(JSON.stringify(claims))
    const signature = sign('sha256', Buffer.from(`${head}.${body}`), key)
    return `${head}.${body}.${base64url(signature)}`
  }

  const fake: FakeKeycloak = {
    get issuer() {
      return issuer
    },
    clientId: 'signin-reports-bff',
    clientSecret: 'test-client-secret',
    tokenRequests: [],
    failDiscovery: false,
    failToken: false,
    issueCode(code) {
      const value = randomBytes(16).toString('hex')
      codes.set(value, code)
      return value
    },
    signIdToken(claims, header = {}) {
      return signWith(privateKey, claims, header)
    },
    close: () => server.close(),
  }

  server.get(`${realm}/.well-known/openid-configuration`, async (_request, reply) => {
    if (fake.failDiscovery) return reply.code(503).send({ error: 'unavailable' })
    return {
      issuer,
      authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
      token_endpoint: `${issuer}/protocol/openid-connect/token`,
      jwks_uri: `${issuer}/protocol/openid-connect/certs`,
      end_session_endpoint: `${issuer}/protocol/openid-connect/logout`,
    }
  })

  server.get(`${realm}/protocol/openid-connect/certs`, async () => ({
    keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }],
  }))

  server.post(`${realm}/protocol/openid-connect/token`, async (request, reply) => {
    const form = request.body as Record<string, string>
    fake.tokenRequests.push(form)
    if (fake.failToken) return reply.code(500).send({ error: 'server_error' })
    const issued = codes.get(form.code ?? '')
    codes.delete(form.code ?? '')
    if (
      issued === undefined ||
      form.grant_type !== 'authorization_code' ||
      form.client_id !== fake.clientId ||
      form.client_secret !== fake.clientSecret
    ) {
      return reply.code(400).send({ error: 'invalid_grant' })
    }
    const challenge = createHash('sha256')
      .update(form.code_verifier ?? '')
      .digest('base64url')
    if (challenge !== issued.challenge) return reply.code(400).send({ error: 'invalid_grant' })
    return {
      access_token: 'kc-access-token-value',
      refresh_token: 'kc-refresh-token-value',
      token_type: 'Bearer',
      id_token: signWith(privateKey, issued.claims, {}),
    }
  })

  await server.listen({ port: 0, host: '127.0.0.1' })
  const address = server.server.address()
  if (address === null || typeof address === 'string') throw new Error('fake keycloak has no port')
  issuer = `http://127.0.0.1:${address.port}/realms/signin-reports`
  return fake
}
