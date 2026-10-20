/* CMP-2 BFF for ST-1: sign-in with PKCE, state and nonce (IF-1, IF-2), sign-out (IF-3), the current account (IF-4)
 * and the role gate every /api route passes; for ST-7 the report history (IF-27). Tokens stay here; the browser only ever holds __Host-sr_session (AD-5). */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import type { AuditLog } from './audit.js'
import { OidcUnavailableError, type OidcClient } from './auth/oidc.js'
import { hasAnyAccess, rolesFromClaim, type Role } from './auth/roles.js'
import type { Clock } from './clock.js'
import type { Config } from './config.js'
import { clearCookie, LOGIN_COOKIE, readCookie, serializeCookie, SESSION_COOKIE } from './http/cookies.js'
import { problemSchema, sendProblem } from './http/problem.js'
import { registerReportHistory } from './history/route.js'
import type { ReportHistoryStore } from './history/store.js'
import { deriveKeys, pkceChallenge, randomToken, seal, unseal } from './security/crypto.js'
import {
  ABSOLUTE_TIMEOUT_MS,
  LOGIN_TRANSACTION_TTL_MS,
  loginTransactionExpired,
  sessionExpiry,
} from './session/policy.js'
import { SessionService } from './session/service.js'
import type { SessionRecord, SessionStore } from './session/store.js'

export { LOGIN_COOKIE, SESSION_COOKIE } from './http/cookies.js'

/* Every /api route declares who may call it: a role, any signed-in session, or 'none' for public. Undeclared fails closed. */
export type RequiredRole = Role | 'session' | 'none'

declare module 'fastify' {
  interface FastifyContextConfig {
    requiredRole?: RequiredRole
  }
  interface FastifyRequest {
    session: SessionRecord | null
  }
}

export interface AppDeps {
  config: Config
  clock: Clock
  sessions: SessionStore
  audit: AuditLog
  oidc: OidcClient
  reportHistory: ReportHistoryStore
}

interface LoginTransaction {
  state: string
  nonce: string
  verifier: string
  returnTo: string
  createdAt: number
}

const TRANSACTION_BINDING = 'sr-login'
const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/

function traceIdFrom(header: string | string[] | undefined): string {
  const match = typeof header === 'string' ? TRACEPARENT.exec(header) : null
  const traceId = match?.[1]
  return traceId && !/^0+$/.test(traceId) ? traceId : randomBytes(16).toString('hex')
}

function sameOrigin(returnTo: string, origin: string): boolean {
  return new URL(returnTo, origin).origin === origin
}

function equalStrings(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function errorCode(error: string, description: string | undefined): string {
  const entra = /AADSTS\d+/.exec(description ?? '')?.[0]
  return entra ?? (error.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'unknown_error')
}

const loginQuerySchema = {
  type: 'object',
  properties: {
    returnTo: { type: 'string', pattern: '^/[^/\\\\].*$|^/$', maxLength: 512 },
    maxAge: { type: 'integer', minimum: 0, maximum: 900 },
  },
} as const

const callbackQuerySchema = {
  type: 'object',
  properties: {
    code: { type: 'string', maxLength: 2048 },
    state: { type: 'string', maxLength: 512 },
    error: { type: 'string', maxLength: 256 },
    error_description: { type: 'string', maxLength: 2048 },
  },
} as const

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

export function buildApp(deps: AppDeps): FastifyInstance {
  const { config, clock, audit, oidc } = deps
  const keys = deriveKeys(config.sessionKey.reveal())
  const sessions = new SessionService(deps.sessions, clock, keys.refreshToken)
  const app = Fastify({ logger: false, genReqId: (raw) => traceIdFrom(raw.headers.traceparent) })

  app.decorateRequest('session', null)

  async function denied(
    request: FastifyRequest,
    reply: FastifyReply,
    session: SessionRecord,
    reason: 'no-role' | 'missing-role' | 'route-undeclared',
    requiredRole?: Role,
  ) {
    await audit.record({
      type: 'access-denied',
      account: session.account,
      reason,
      ...(requiredRole === undefined ? {} : { requiredRole }),
      route: request.routeOptions.url ?? request.url,
      traceId: request.id,
      at: clock.now().toISOString(),
    })
  }

  /* The role gate (AD-7): runs before validation, so an anonymous caller learns nothing beyond 401. */
  app.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions.url
    if (route === undefined || !route.startsWith('/api/')) return
    const required = request.routeOptions.config.requiredRole
    if (required === 'none') return
    request.session = await sessions.resolve(readCookie(request.headers.cookie, SESSION_COOKIE))
    const session = request.session
    if (!session) return sendProblem(request, reply, 401)
    if (required === 'session') return
    if (required === undefined) {
      await denied(request, reply, session, 'route-undeclared')
      return sendProblem(request, reply, 403)
    }
    if (!session.roles.includes(required)) {
      await denied(request, reply, session, 'missing-role', required)
      return sendProblem(request, reply, 403)
    }
  })

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store')
    return payload
  })

  app.setNotFoundHandler((request, reply) => sendProblem(request, reply, 404))

  app.setErrorHandler((error: { validation?: unknown; statusCode?: number }, request, reply) => {
    if (error.validation) return sendProblem(request, reply, 400)
    const status =
      error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500
    return sendProblem(request, reply, status)
  })

  app.get<{ Querystring: { returnTo?: string; maxAge?: number } }>(
    '/auth/login',
    {
      config: { requiredRole: 'none' },
      schema: { querystring: loginQuerySchema, response: { 400: problemSchema, 503: problemSchema } },
    },
    async (request, reply) => {
      const returnTo = request.query.returnTo ?? '/'
      if (!sameOrigin(returnTo, config.publicOrigin)) return sendProblem(request, reply, 400)
      const transaction: LoginTransaction = {
        state: randomToken(),
        nonce: randomToken(),
        verifier: randomToken(),
        returnTo,
        createdAt: clock.now().getTime(),
      }
      let location: string
      try {
        location = await oidc.authorizationUrl({
          state: transaction.state,
          nonce: transaction.nonce,
          codeChallenge: pkceChallenge(transaction.verifier),
          ...(request.query.maxAge === undefined ? {} : { maxAge: request.query.maxAge }),
        })
      } catch (problem) {
        if (problem instanceof OidcUnavailableError) return sendProblem(request, reply, 503)
        throw problem
      }
      const sealed = seal(keys.transaction, JSON.stringify(transaction), TRANSACTION_BINDING)
      return reply
        .header('set-cookie', serializeCookie(LOGIN_COOKIE, sealed, 'Lax', LOGIN_TRANSACTION_TTL_MS / 1000))
        .redirect(location, 302)
    },
  )

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    '/auth/callback',
    { config: { requiredRole: 'none' }, schema: { querystring: callbackQuerySchema } },
    async (request, reply) => {
      const cookies = [clearCookie(LOGIN_COOKIE, 'Lax')]
      const fail = (code: string) => {
        const target = new URLSearchParams({ error: code, ref: request.id, at: clock.now().toISOString() })
        return reply.header('set-cookie', cookies).redirect(`/signin?${target.toString()}`, 302)
      }
      const { code, state, error, error_description } = request.query
      if (error !== undefined) return fail(errorCode(error, error_description))

      const opened = unseal(
        keys.transaction,
        readCookie(request.headers.cookie, LOGIN_COOKIE) ?? '',
        TRANSACTION_BINDING,
      )
      const transaction = opened === null ? null : (JSON.parse(opened) as LoginTransaction)
      if (
        !transaction ||
        !code ||
        !state ||
        !equalStrings(state, transaction.state) ||
        loginTransactionExpired(new Date(transaction.createdAt), clock.now())
      ) {
        return fail('invalid_state')
      }

      let exchange
      try {
        exchange = await oidc.exchangeCode({ code, codeVerifier: transaction.verifier, nonce: transaction.nonce })
      } catch (problem) {
        return fail(problem instanceof OidcUnavailableError ? 'idp_unavailable' : 'token_rejected')
      }

      /* Rotation at login: whatever session this browser held before is gone. */
      await sessions.end(readCookie(request.headers.cookie, SESSION_COOKIE))
      const { claims } = exchange
      const account = claims.upn ?? claims.preferred_username ?? claims.sub
      const { sessionId, record } = await sessions.open({
        subject: claims.sub,
        account,
        displayName: claims.name ?? account,
        roles: rolesFromClaim(claims.roles),
        authTime: new Date((claims.auth_time ?? claims.iat) * 1000),
        refreshToken: exchange.refreshToken,
      })
      if (!hasAnyAccess(record.roles)) await denied(request, reply, record, 'no-role')
      cookies.push(serializeCookie(SESSION_COOKIE, sessionId, 'Strict', ABSOLUTE_TIMEOUT_MS / 1000))
      return reply.header('set-cookie', cookies).redirect(transaction.returnTo, 302)
    },
  )

  app.post('/auth/logout', { config: { requiredRole: 'none' } }, async (request, reply) => {
    const { refreshToken } = await sessions.end(readCookie(request.headers.cookie, SESSION_COOKIE))
    if (refreshToken) {
      /* The local session is already gone; a Keycloak outage must not keep the user signed in here. */
      await oidc.endSession(refreshToken).catch(() => undefined)
    }
    return reply.header('set-cookie', clearCookie(SESSION_COOKIE, 'Strict')).code(204).send()
  })

  app.get(
    '/api/v1/me',
    {
      config: { requiredRole: 'session' },
      schema: { response: { 200: meSchema, 401: problemSchema, 403: problemSchema } },
    },
    async (request, reply) => {
      const session = request.session!
      if (!hasAnyAccess(session.roles)) {
        await denied(request, reply, session, 'no-role')
        return sendProblem(request, reply, 403, {
          type: '/problems/no-access',
          title: `You don't have access. Signed in as ${session.account}.`,
        })
      }
      const { idleExpiresAt, absoluteExpiresAt } = sessionExpiry(session)
      return {
        account: session.account,
        displayName: session.displayName,
        roles: session.roles,
        authTime: session.authTime.toISOString(),
        idleExpiresAt: idleExpiresAt.toISOString(),
        absoluteExpiresAt: absoluteExpiresAt.toISOString(),
      }
    },
  )

  registerReportHistory(app, { clock, store: deps.reportHistory })

  return app
}
