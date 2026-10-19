/* IF-1 GET /auth/login, GET /auth/callback and POST /auth/logout (AD-5). The login transaction (state, nonce,
 * PKCE verifier, returnTo, maxAge) travels sealed in the 5-minute SameSite=Lax __Host-sr_login cookie; the
 * session is an opaque __Host-sr_session cookie and every token stays server-side. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { rolesFromClaims } from '../access.js'
import type { AppDeps } from '../app.js'
import { LOGIN_COOKIE, parseCookies, serializeCookie, SESSION_COOKIE } from '../cookies.js'
import { IdentityProviderUnavailable, IdTokenInvalid, TokenExchangeRejected } from '../oidc/client.js'
import { PROBLEMS, problemSchema, sendProblem } from '../problem.js'
import { deriveKey, hashSessionId, newSessionId, openToken, sealToken } from '../session/crypto.js'

const LOGIN_TTL_S = 300

const transactionSchema = z.object({
  state: z.string(),
  nonce: z.string(),
  verifier: z.string(),
  returnTo: z.string().optional(),
  maxAge: z.number().optional(),
  startedAt: z.number(),
})
type LoginTransaction = z.infer<typeof transactionSchema>

interface LoginQuery {
  returnTo?: string
  maxAge?: number
}

interface CallbackQuery {
  code?: string
  state?: string
  error?: string
  error_description?: string
}

const random = (): string => randomBytes(32).toString('base64url')

const sameText = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/** The Entra AADSTS code when Keycloak passed one through, else the OAuth error, else unknown_error. */
function failureCode(error: string, description: string | undefined): string {
  const entra = /AADSTS\d+/.exec(description ?? '')?.[0]
  if (entra !== undefined) return entra
  return /^[a-z_]{1,64}$/.test(error) ? error : 'unknown_error'
}

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const loginKey = deriveKey(deps.config.sessionKey.reveal(), 'login-transaction')
  const refreshKey = deriveKey(deps.config.sessionKey.reveal(), 'refresh-token')
  const redirectUri = `${deps.config.publicOrigin}/auth/callback`
  const clearLoginCookie = serializeCookie(LOGIN_COOKIE, '', { sameSite: 'Lax', maxAge: 0 })

  app.get<{ Querystring: LoginQuery }>(
    '/auth/login',
    {
      config: { access: 'public' },
      schema: {
        querystring: {
          type: 'object',
          properties: {
            returnTo: { type: 'string', pattern: '^/[^/\\\\].*$|^/$', maxLength: 512 },
            maxAge: { type: 'integer', minimum: 0, maximum: 900 },
          },
        },
        response: { 400: problemSchema, 503: problemSchema },
      },
    },
    async (request, reply) => {
      const transaction: LoginTransaction = {
        state: random(),
        nonce: random(),
        verifier: random(),
        returnTo: request.query.returnTo,
        maxAge: request.query.maxAge,
        startedAt: deps.clock.now().getTime(),
      }
      let location: string
      try {
        location = await deps.oidc.authorizationUrl({
          redirectUri,
          state: transaction.state,
          nonce: transaction.nonce,
          codeChallenge: createHash('sha256').update(transaction.verifier).digest('base64url'),
          idpHint: deps.config.oidcIdpHint,
          maxAge: transaction.maxAge,
        })
      } catch (error) {
        if (error instanceof IdentityProviderUnavailable) {
          return sendProblem(request, reply, PROBLEMS.identityProviderUnavailable)
        }
        throw error
      }
      const sealed = sealToken(loginKey, JSON.stringify(transaction), 'login-transaction')
      return reply
        .header('set-cookie', serializeCookie(LOGIN_COOKIE, sealed, { sameSite: 'Lax', maxAge: LOGIN_TTL_S }))
        .header('cache-control', 'no-store')
        .redirect(location, 302)
    },
  )

  const openTransaction = (request: FastifyRequest): LoginTransaction | undefined => {
    const sealed = parseCookies(request.headers.cookie).get(LOGIN_COOKIE)
    if (sealed === undefined || sealed === '') return undefined
    try {
      const transaction = transactionSchema.parse(JSON.parse(openToken(loginKey, sealed, 'login-transaction')))
      const ageMs = deps.clock.now().getTime() - transaction.startedAt
      return ageMs <= LOGIN_TTL_S * 1000 ? transaction : undefined
    } catch {
      return undefined
    }
  }

  const fail = (request: FastifyRequest, reply: FastifyReply, code: string): FastifyReply => {
    const query = new URLSearchParams({ code, ref: request.traceId, at: deps.clock.now().toISOString() })
    return reply
      .header('set-cookie', clearLoginCookie)
      .header('cache-control', 'no-store')
      .redirect(`/signin/failed?${query.toString()}`, 302)
  }

  app.get<{ Querystring: CallbackQuery }>(
    '/auth/callback',
    {
      config: { access: 'public' },
      schema: {
        querystring: {
          type: 'object',
          properties: {
            code: { type: 'string', maxLength: 4096 },
            state: { type: 'string', maxLength: 256 },
            error: { type: 'string', maxLength: 256 },
            error_description: { type: 'string', maxLength: 4096 },
          },
        },
        response: { 400: problemSchema },
      },
    },
    async (request, reply) => {
      const query = request.query
      if (query.error !== undefined) return fail(request, reply, failureCode(query.error, query.error_description))
      const transaction = openTransaction(request)
      if (transaction === undefined) return fail(request, reply, 'login_expired')
      if (query.state === undefined || !sameText(query.state, transaction.state)) {
        return fail(request, reply, 'state_mismatch')
      }
      if (query.code === undefined) return fail(request, reply, 'invalid_callback')

      let claims: Record<string, unknown>
      let refreshToken: string
      try {
        const tokens = await deps.oidc.exchangeCode({
          code: query.code,
          codeVerifier: transaction.verifier,
          redirectUri,
        })
        claims = await deps.oidc.verifyIdToken(tokens.idToken, { nonce: transaction.nonce, maxAge: transaction.maxAge })
        refreshToken = tokens.refreshToken
      } catch (error) {
        if (error instanceof TokenExchangeRejected) return fail(request, reply, 'token_exchange_failed')
        if (error instanceof IdTokenInvalid) return fail(request, reply, 'token_invalid')
        if (error instanceof IdentityProviderUnavailable) return fail(request, reply, 'identity_provider_unavailable')
        throw error
      }

      /* rotation at login: whatever session the browser held ends here */
      const previous = parseCookies(request.headers.cookie).get(SESSION_COOKIE)
      if (previous !== undefined) await deps.sessions.delete(hashSessionId(previous))

      const now = deps.clock.now()
      const account = String(claims.upn ?? claims.preferred_username ?? claims.sub)
      const roles = rolesFromClaims(claims)
      const sessionId = newSessionId()
      await deps.sessions.create({
        idHash: hashSessionId(sessionId),
        refreshTokenCiphertext: sealToken(refreshKey, refreshToken, 'refresh-token'),
        account,
        displayName: typeof claims.name === 'string' ? claims.name : account,
        roles,
        authTime: new Date((claims.auth_time as number) * 1000),
        createdAt: now,
        lastSeenAt: now,
      })
      if (roles.length === 0) {
        await deps.audit.record({
          type: 'access-denied',
          account,
          roles,
          method: request.method,
          route: '/auth/callback',
          traceId: request.traceId,
          at: now,
        })
      }
      return reply
        .header('set-cookie', [clearLoginCookie, serializeCookie(SESSION_COOKIE, sessionId, { sameSite: 'Strict' })])
        .header('cache-control', 'no-store')
        .redirect(transaction.returnTo ?? '/', 302)
    },
  )

  app.post('/auth/logout', { config: { access: 'public' } }, async (request, reply) => {
    const session = request.session
    if (session !== null) {
      await deps.sessions.delete(session.idHash)
      try {
        await deps.oidc.endSession(openToken(refreshKey, session.refreshTokenCiphertext, 'refresh-token'))
      } catch {
        request.log.warn({ traceId: request.traceId }, 'Keycloak session could not be ended; the local session was')
      }
    }
    return reply
      .header('set-cookie', serializeCookie(SESSION_COOKIE, '', { sameSite: 'Strict', maxAge: 0 }))
      .header('cache-control', 'no-store')
      .code(204)
      .send()
  })
}
