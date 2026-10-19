/* CMP-2 BFF for ST-1: the OIDC sign-in with PKCE, state and nonce (IF-1), the callback and sign-out, the current
 * account (IF-4), and the session and role guards every report route sits behind (AC-7). Tokens stay here: the
 * browser receives only the opaque __Host-sr_session cookie (AD-5, AC-8). */
import Fastify, { type FastifyInstance, type FastifyPluginAsync, type FastifyReply, type FastifyRequest } from 'fastify'
import type { AuditLog } from './audit.js'
import type { Clock } from './clock.js'
import {
  LOGIN_COOKIE,
  LOGIN_COOKIE_MAX_AGE_S,
  SESSION_COOKIE,
  clearCookie,
  parseCookies,
  serializeCookie,
} from './cookies.js'
import { pkceChallenge, randomToken, seal, sha256Hex, unseal } from './crypto.js'
import { OidcUnavailableError, type OidcClient } from './oidc.js'
import { problemSchema, sendProblem } from './problem.js'
import { hasAnyAccess, hasRole, rolesFromClaim, type Role } from './roles.js'
import { ABSOLUTE_LIMIT_MS, absoluteExpiresAt, idleExpiresAt, isSessionExpired } from './session-policy.js'
import type { SessionStore, StoredSession } from './session-store.js'
import { traceIdFrom } from './trace.js'

export interface AppDependencies {
  publicOrigin: string
  /* 32-byte AES-256-GCM key sealing refresh tokens at rest and the login transaction cookie. */
  sealingKey: Buffer
  oidc: OidcClient
  sessions: SessionStore
  audit: AuditLog
  clock: Clock
  /* Report routes registered by later stories; every one of them requires a session holding 'reader'. */
  reportRoutes?: FastifyPluginAsync
  logger?: boolean | object
}

declare module 'fastify' {
  interface FastifyRequest {
    traceId: string
    srSession: StoredSession | null
  }
}

interface LoginTransaction {
  state: string
  nonce: string
  verifier: string
  returnTo: string
  expiresAt: number
}

const returnToSchema = { type: 'string', pattern: '^/[^/\\\\].*$|^/$', maxLength: 512 } as const
const NO_STORE = 'no-store'

const meSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['account', 'displayName', 'roles', 'authTime', 'idleExpiresAt', 'absoluteExpiresAt'],
  properties: {
    account: { type: 'string' },
    displayName: { type: 'string' },
    roles: { type: 'array', items: { type: 'string' } },
    authTime: { type: 'string' },
    idleExpiresAt: { type: 'string' },
    absoluteExpiresAt: { type: 'string' },
  },
} as const

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false })
  const redirectUri = `${deps.publicOrigin}/auth/callback`

  app.decorateRequest('traceId', '')
  app.decorateRequest('srSession', null)
  app.addHook('onRequest', async (request) => {
    request.traceId = traceIdFrom(request.headers.traceparent)
  })

  function problem(reply: FastifyReply, request: FastifyRequest, status: number, type: string, title: string) {
    return sendProblem(reply, { type, title, status, traceId: request.traceId })
  }

  function sessionCookieId(request: FastifyRequest): string | undefined {
    return parseCookies(request.headers.cookie).get(SESSION_COOKIE) || undefined
  }

  async function denied(request: FastifyRequest, session: StoredSession, reason: string): Promise<void> {
    await deps.audit.record({
      type: 'access.denied',
      at: deps.clock.now(),
      traceId: request.traceId,
      subject: session.subject,
      account: session.account,
      route: request.routeOptions.url ?? request.url,
      reason,
    })
  }

  /* Resolves the session from the cookie, ending it at the idle or absolute limit; answers 401 otherwise. */
  async function requireSession(request: FastifyRequest, reply: FastifyReply) {
    const id = sessionCookieId(request)
    const idHash = id === undefined ? undefined : sha256Hex(id)
    const session = idHash === undefined ? undefined : await deps.sessions.findByHash(idHash)
    const now = deps.clock.now()
    if (session === undefined || isSessionExpired(session, now)) {
      if (session !== undefined) await deps.sessions.delete(session.idHash)
      if (id !== undefined) reply.header('set-cookie', clearCookie(SESSION_COOKIE, 'Strict'))
      return problem(reply, request, 401, '/problems/unauthenticated', 'Sign-in required')
    }
    await deps.sessions.touch(session.idHash, now)
    request.srSession = { ...session, lastSeenAt: now }
  }

  function requireRole(role: Role) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const session = request.srSession
      if (session === null || hasRole(session.roles, role)) return
      await denied(request, session, `missing role ${role}`)
      return problem(reply, request, 403, '/problems/forbidden', 'Forbidden')
    }
  }

  app.get(
    '/auth/login',
    {
      attachValidation: true,
      schema: {
        querystring: {
          type: 'object',
          properties: { returnTo: returnToSchema, maxAge: { type: 'integer', minimum: 0, maximum: 900 } },
        },
        response: { 400: problemSchema, 503: problemSchema },
      },
    },
    async (request, reply) => {
      if (request.validationError) {
        return problem(reply, request, 400, '/problems/invalid-request', 'returnTo or maxAge is invalid')
      }
      const query = request.query as { returnTo?: string; maxAge?: number }
      const transaction: LoginTransaction = {
        state: randomToken(),
        nonce: randomToken(),
        verifier: randomToken(48),
        returnTo: query.returnTo ?? '/',
        expiresAt: deps.clock.now().getTime() + LOGIN_COOKIE_MAX_AGE_S * 1000,
      }
      let location: string
      try {
        location = await deps.oidc.authorizationUrl({
          state: transaction.state,
          nonce: transaction.nonce,
          codeChallenge: pkceChallenge(transaction.verifier),
          redirectUri,
          ...(query.maxAge === undefined ? {} : { maxAge: query.maxAge }),
        })
      } catch {
        return problem(reply, request, 503, '/problems/idp-unavailable', 'Sign-in is unavailable')
      }
      return reply
        .header('cache-control', NO_STORE)
        .header(
          'set-cookie',
          serializeCookie(LOGIN_COOKIE, seal(JSON.stringify(transaction), deps.sealingKey), {
            sameSite: 'Lax',
            maxAgeSeconds: LOGIN_COOKIE_MAX_AGE_S,
          }),
        )
        .redirect(location, 302)
    },
  )

  app.get(
    '/auth/callback',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            code: { type: 'string', maxLength: 4096 },
            state: { type: 'string', maxLength: 512 },
            error: { type: 'string', maxLength: 256 },
            error_description: { type: 'string', maxLength: 2048 },
          },
        },
      },
      attachValidation: true,
    },
    async (request, reply) => {
      const now = deps.clock.now()
      const query = (request.validationError ? {} : request.query) as Record<string, string | undefined>
      const sealed = parseCookies(request.headers.cookie).get(LOGIN_COOKIE)
      reply.header('cache-control', NO_STORE).header('set-cookie', clearCookie(LOGIN_COOKIE, 'Lax'))

      const fail = async (code: string) => {
        await deps.audit.record({ type: 'signin.failed', at: now, traceId: request.traceId, reason: code })
        const target = new URLSearchParams({ error: code, ref: request.traceId, at: now.toISOString() })
        return reply.redirect(`/signin?${target.toString()}`, 302)
      }

      if (query.error !== undefined) {
        /* AC-6: surface the Entra AADSTS code when Keycloak relays one, else the OAuth error code. */
        const entraCode = /AADSTS\d+/.exec(query.error_description ?? '')?.[0]
        return fail(entraCode ?? (/^[a-z_]+$/.test(query.error) ? query.error : 'invalid_request'))
      }

      const transaction = openTransaction(sealed, now)
      if (transaction === undefined || query.state !== transaction.state || query.code === undefined) {
        return fail('invalid_state')
      }

      let signIn
      try {
        signIn = await deps.oidc.completeSignIn({
          code: query.code,
          codeVerifier: transaction.verifier,
          redirectUri,
          nonce: transaction.nonce,
        })
      } catch (error) {
        return fail(error instanceof OidcUnavailableError ? 'idp_unavailable' : 'token_rejected')
      }

      /* Rotation at login: a session presented with the callback is ended, never reused. */
      const previous = sessionCookieId(request)
      if (previous !== undefined) await deps.sessions.delete(sha256Hex(previous))

      const id = randomToken()
      const { identity, refreshToken } = signIn
      await deps.sessions.create({
        idHash: sha256Hex(id),
        subject: identity.subject,
        account: identity.account,
        displayName: identity.displayName,
        roles: rolesFromClaim(identity.roles),
        authTime: identity.authTime,
        createdAt: now,
        lastSeenAt: now,
        refreshTokenCiphertext: refreshToken === null ? null : seal(refreshToken, deps.sealingKey),
      })
      await deps.audit.record({
        type: 'session.signed_in',
        at: now,
        traceId: request.traceId,
        subject: identity.subject,
        account: identity.account,
      })
      return reply
        .header(
          'set-cookie',
          serializeCookie(SESSION_COOKIE, id, { sameSite: 'Strict', maxAgeSeconds: ABSOLUTE_LIMIT_MS / 1000 }),
        )
        .redirect(transaction.returnTo, 302)
    },
  )

  function openTransaction(sealed: string | undefined, now: Date): LoginTransaction | undefined {
    if (sealed === undefined) return undefined
    try {
      const transaction = JSON.parse(unseal(sealed, deps.sealingKey)) as LoginTransaction
      return transaction.expiresAt > now.getTime() ? transaction : undefined
    } catch {
      return undefined
    }
  }

  app.post('/auth/logout', async (request, reply) => {
    const id = sessionCookieId(request)
    const session = id === undefined ? undefined : await deps.sessions.findByHash(sha256Hex(id))
    if (session !== undefined) {
      await deps.sessions.delete(session.idHash)
      if (session.refreshTokenCiphertext !== null) {
        try {
          await deps.oidc.endSession(unseal(session.refreshTokenCiphertext, deps.sealingKey))
        } catch {
          /* The local session is already gone; Keycloak's own idle limit ends its session. */
          request.log.warn({ traceId: request.traceId }, 'Keycloak logout failed')
        }
      }
      await deps.audit.record({
        type: 'session.signed_out',
        at: deps.clock.now(),
        traceId: request.traceId,
        subject: session.subject,
        account: session.account,
      })
    }
    return reply
      .header('cache-control', NO_STORE)
      .header('set-cookie', clearCookie(SESSION_COOKIE, 'Strict'))
      .code(204)
      .send()
  })

  app.get(
    '/api/v1/me',
    {
      preHandler: requireSession,
      schema: { response: { 200: meSchema, 401: problemSchema, 403: problemSchema } },
    },
    async (request, reply) => {
      const session = request.srSession as StoredSession
      if (!hasAnyAccess(session.roles)) {
        await denied(request, session, 'neither reader nor administrator')
        return problem(
          reply,
          request,
          403,
          '/problems/no-access',
          `You don't have access. Signed in as ${session.account}.`,
        )
      }
      return reply.header('cache-control', NO_STORE).send({
        account: session.account,
        displayName: session.displayName,
        roles: session.roles,
        authTime: session.authTime.toISOString(),
        idleExpiresAt: idleExpiresAt(session).toISOString(),
        absoluteExpiresAt: absoluteExpiresAt(session).toISOString(),
      })
    },
  )

  const reportRoutes = deps.reportRoutes
  if (reportRoutes !== undefined) {
    app.register(
      async (scope) => {
        scope.addHook('preHandler', requireSession)
        scope.addHook('preHandler', requireRole('reader'))
        await scope.register(reportRoutes)
      },
      { prefix: '/api/v1/reports' },
    )
  }

  return app
}
