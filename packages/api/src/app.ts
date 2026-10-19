/* CMP-2: the BFF. Every request gets a trace ID and its session (if any); every route then passes the access
 * guard, which reads the route's declared access and fails closed to 'reader' when none is declared (AD-7). */
import Fastify, { type FastifyInstance } from 'fastify'
import { decideAccess, type RouteAccess } from './access.js'
import type { AuditSink } from './audit.js'
import { registerAuthRoutes } from './auth/routes.js'
import type { Clock } from './clock.js'
import type { ApiConfig } from './config.js'
import { parseCookies, SESSION_COOKIE } from './cookies.js'
import { registerMeRoute } from './me.js'
import type { OidcClient } from './oidc/client.js'
import { noAccessProblem, PROBLEMS, sendProblem, traceIdFrom } from './problem.js'
import { hashSessionId } from './session/crypto.js'
import { sessionState } from './session/policy.js'
import type { SessionStore, StoredSession } from './session/store.js'

declare module 'fastify' {
  interface FastifyRequest {
    traceId: string
    session: StoredSession | null
  }
  interface FastifyContextConfig {
    access?: RouteAccess
  }
}

export interface AppDeps {
  config: ApiConfig
  clock: Clock
  sessions: SessionStore
  audit: AuditSink
  oidc: OidcClient
  logger?: boolean
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? false,
    /* the session cookie and the callback's code never reach a log line */
    disableRequestLogging: true,
  })
  app.decorateRequest('traceId', '')
  app.decorateRequest('session', null)

  app.addHook('onRequest', async (request, reply) => {
    request.traceId = traceIdFrom(request.headers.traceparent)
    request.session = await loadSession(deps, parseCookies(request.headers.cookie).get(SESSION_COOKIE))

    const access = request.routeOptions.config.access ?? 'reader'
    const decision = decideAccess(request.session?.roles ?? null, access)
    if (decision === 'allow') return
    if (decision === 'unauthenticated') return sendProblem(request, reply, PROBLEMS.unauthenticated)
    const session = request.session as StoredSession
    await deps.audit.record({
      type: 'access-denied',
      account: session.account,
      roles: session.roles,
      method: request.method,
      route: request.routeOptions.url ?? '(no route)',
      traceId: request.traceId,
      at: deps.clock.now(),
    })
    return sendProblem(request, reply, decision === 'no-access' ? noAccessProblem(session.account) : PROBLEMS.forbidden)
  })

  app.setNotFoundHandler((request, reply) => sendProblem(request, reply, PROBLEMS.notFound))
  app.setErrorHandler((error: { validation?: unknown; statusCode?: number }, request, reply) => {
    if (error.validation !== undefined) return sendProblem(request, reply, PROBLEMS.invalidRequest)
    const status = error.statusCode ?? 500
    if (status >= 400 && status < 500) {
      return sendProblem(request, reply, {
        status,
        type: PROBLEMS.invalidRequest.type,
        title: PROBLEMS.invalidRequest.title,
      })
    }
    request.log.error({ traceId: request.traceId }, 'request failed')
    return sendProblem(request, reply, PROBLEMS.internal)
  })

  registerAuthRoutes(app, deps)
  registerMeRoute(app)
  return app
}

/** The live session for a cookie value, after the AD-5 limits; an expired one is deleted and activity is recorded. */
async function loadSession(deps: AppDeps, sessionId: string | undefined): Promise<StoredSession | null> {
  if (sessionId === undefined || sessionId === '') return null
  const idHash = hashSessionId(sessionId)
  const session = await deps.sessions.find(idHash)
  if (session === undefined) return null
  const now = deps.clock.now()
  if (sessionState(session, now) !== 'active') {
    await deps.sessions.delete(idHash)
    return null
  }
  await deps.sessions.touch(idHash, now)
  return { ...session, lastSeenAt: now }
}
