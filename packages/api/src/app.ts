/* CMP-2 BFF for ST-1: sign-in (IF-1), callback (IF-2), sign-out (IF-3), the current account (IF-4),
 * keepalive for "Stay signed in", and the reader gate in front of every report endpoint (AD-5, AD-7). */
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import type { AuditSink } from './audit'
import type { Clock } from './clock'
import type { ApiConfig } from './config'
import { parseCookies, serializeCookie } from './cookies'
import { open, pkceChallenge, randomToken, safeEqual, seal, sha256Hex } from './crypto'
import { OidcUnavailableError, type OidcClient } from './oidc'
import { noAccess, problemSchema, problems, sendProblem, traceIdFrom, type Problem } from './problem'
import { hasAnyAccess, rolesFromClaims, type Role } from './roles'
import { ABSOLUTE_LIMIT_MS, expiryReason, sessionLimits } from './session-policy'
import type { SessionStore, StoredSession } from './session-store'

declare module 'fastify' {
  interface FastifyRequest {
    traceId: string
  }
}

export const SESSION_COOKIE = '__Host-sr_session'
export const LOGIN_COOKIE = '__Host-sr_login'
const LOGIN_TRANSACTION_MS = 5 * 60 * 1000
const REPORTS_PREFIX = '/api/v1/reports'

export interface AppDependencies {
  config: ApiConfig
  clock: Clock
  oidc: OidcClient
  sessions: SessionStore
  audit: AuditSink
  logStream?: { write(line: string): void }
}

interface LoginTransaction {
  state: string
  nonce: string
  verifier: string
  returnTo: string
  expiresAt: number
}

const clearSession = serializeCookie(SESSION_COOKIE, '', { sameSite: 'Strict', maxAge: 0 })
const clearLogin = serializeCookie(LOGIN_COOKIE, '', { sameSite: 'Lax', maxAge: 0 })

const pathOf = (url: string) => url.split('?')[0] ?? url

const meSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['account', 'displayName', 'roles', 'authTime', 'idleExpiresAt', 'absoluteExpiresAt'],
  properties: {
    account: { type: 'string' },
    displayName: { type: 'string' },
    roles: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', enum: ['reader', 'config.read', 'config.write', 'config.approve'] },
    },
    authTime: { type: 'string', format: 'date-time' },
    idleExpiresAt: { type: 'string', format: 'date-time' },
    absoluteExpiresAt: { type: 'string', format: 'date-time' },
  },
} as const

const sessionRoute = {
  security: [{ sessionCookie: [] }],
  response: { 200: meSchema, 401: problemSchema, 403: problemSchema },
}

export function buildApp({ config, clock, oidc, sessions, audit, logStream }: AppDependencies): FastifyInstance {
  const key = config.sessionKey.reveal()
  const redirectUri = `${config.publicOrigin}/auth/callback`

  const app = Fastify({
    logger:
      logStream === undefined
        ? false
        : {
            stream: logStream,
            /* Query strings carry the authorization code and state: log the path only. */
            serializers: { req: (request) => ({ method: request.method, url: pathOf(request.url) }) },
          },
  })

  app.decorateRequest('traceId', '')
  app.addHook('onRequest', async (request) => {
    request.traceId = traceIdFrom(request.headers.traceparent)
  })

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation !== undefined) {
      return sendProblem(reply, problems.invalidRequest)
    }
    request.log.error({ err: { name: error.name } }, 'unhandled error')
    return sendProblem(reply, problems.internal)
  })

  /* Resolves the session cookie; an expired session is removed and its cookie cleared. */
  const currentSession = async (
    request: FastifyRequest,
    reply: FastifyReply,
    { activity }: { activity: boolean },
  ): Promise<StoredSession | null> => {
    const id = parseCookies(request.headers.cookie)[SESSION_COOKIE]
    if (id === undefined || id === '') return null
    const idHash = sha256Hex(id)
    const session = await sessions.find(idHash)
    if (session === undefined) return null
    const now = clock.now()
    if (expiryReason(session, now) !== null) {
      await sessions.remove(idHash)
      reply.header('set-cookie', clearSession)
      return null
    }
    if (activity) {
      await sessions.touch(idHash, now)
      session.lastSeenAt = now
    }
    return session
  }

  const deny = async (
    request: FastifyRequest,
    reply: FastifyReply,
    session: StoredSession,
    problem: Problem = problems.forbidden,
  ) => {
    await audit.record({
      type: 'access.denied',
      account: session.account,
      method: request.method,
      route: pathOf(request.url),
      traceId: request.traceId,
      at: clock.now(),
    })
    return sendProblem(reply, problem)
  }

  /* Every report endpoint, present or future, sits behind the reader role (ST-1 AC-5, AC-7). */
  app.addHook('onRequest', async (request, reply) => {
    const path = pathOf(request.url)
    if (path !== REPORTS_PREFIX && !path.startsWith(`${REPORTS_PREFIX}/`)) return
    const session = await currentSession(request, reply, { activity: true })
    if (session === null) return sendProblem(reply, problems.unauthenticated)
    if (!session.roles.includes('reader')) return deny(request, reply, session)
  })

  const failSignIn = (request: FastifyRequest, reply: FastifyReply, code: string) => {
    const ref = randomUUID()
    request.log.warn({ ref, code }, 'sign-in did not complete')
    const query = new URLSearchParams({ code, ref, at: clock.now().toISOString() })
    return reply.header('set-cookie', clearLogin).redirect(`/signin/error?${query}`, 302)
  }

  const meBody = (session: StoredSession) => {
    const limits = sessionLimits(session)
    return {
      account: session.account,
      displayName: session.displayName,
      roles: session.roles,
      authTime: session.authTime.toISOString(),
      idleExpiresAt: limits.idleExpiresAt.toISOString(),
      absoluteExpiresAt: limits.absoluteExpiresAt.toISOString(),
    }
  }

  const answerMe = (activity: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await currentSession(request, reply, { activity })
    if (session === null) return sendProblem(reply, problems.unauthenticated)
    if (!hasAnyAccess(session.roles)) return deny(request, reply, session, noAccess(session.account))
    return reply.header('cache-control', 'no-store').send(meBody(session))
  }

  app.get<{ Querystring: { returnTo?: string; maxAge?: number } }>(
    '/auth/login',
    {
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
      const verifier = randomToken()
      const transaction: LoginTransaction = {
        state: randomToken(),
        nonce: randomToken(),
        verifier,
        returnTo: request.query.returnTo ?? '/',
        expiresAt: clock.now().getTime() + LOGIN_TRANSACTION_MS,
      }
      let location: string
      try {
        location = await oidc.authorizationUrl({
          state: transaction.state,
          nonce: transaction.nonce,
          codeChallenge: pkceChallenge(verifier),
          redirectUri,
          maxAge: request.query.maxAge,
        })
      } catch {
        return sendProblem(reply, problems.identityProviderUnavailable)
      }
      const cookie = serializeCookie(LOGIN_COOKIE, seal(key, JSON.stringify(transaction)), {
        sameSite: 'Lax',
        maxAge: LOGIN_TRANSACTION_MS / 1000,
      })
      return reply.header('set-cookie', cookie).redirect(location, 302)
    },
  )

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
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
        response: { 400: problemSchema },
      },
    },
    async (request, reply) => {
      const { code, state, error, error_description: description } = request.query
      if (error !== undefined) {
        const entraCode = /AADSTS\d+/.exec(description ?? '')?.[0]
        return failSignIn(request, reply, entraCode ?? (/^[a-z_]{1,64}$/.test(error) ? error : 'unknown_error'))
      }
      if (code === undefined || state === undefined) {
        return sendProblem(reply.header('set-cookie', clearLogin), problems.invalidRequest)
      }
      const cookies = parseCookies(request.headers.cookie)
      const opened = open(key, cookies[LOGIN_COOKIE] ?? '')
      const transaction = opened === null ? null : (JSON.parse(opened) as LoginTransaction)
      if (
        transaction === null ||
        transaction.expiresAt <= clock.now().getTime() ||
        !safeEqual(transaction.state, state)
      ) {
        return sendProblem(reply.header('set-cookie', clearLogin), problems.invalidLoginTransaction)
      }

      let tokens
      try {
        tokens = await oidc.exchangeCode({
          code,
          codeVerifier: transaction.verifier,
          redirectUri,
          nonce: transaction.nonce,
        })
      } catch (problem) {
        return failSignIn(
          request,
          reply,
          problem instanceof OidcUnavailableError ? 'identity_provider_unavailable' : 'token_exchange_failed',
        )
      }

      /* Rotation at login: whatever session the browser held before is ended, and a new ID is issued. */
      const previous = cookies[SESSION_COOKIE]
      if (previous !== undefined && previous !== '') await sessions.remove(sha256Hex(previous))

      const { claims } = tokens
      const account = claims.preferred_username ?? claims.sub
      const roles: Role[] = rolesFromClaims(claims)
      const now = clock.now()
      const id = randomToken()
      await sessions.create({
        idHash: sha256Hex(id),
        account,
        displayName: claims.name ?? account,
        roles,
        authTime: new Date((claims.auth_time ?? claims.iat) * 1000),
        createdAt: now,
        lastSeenAt: now,
        refreshToken: tokens.refreshToken === undefined ? null : seal(key, tokens.refreshToken),
        idToken: seal(key, tokens.idToken),
      })
      const sessionCookie = serializeCookie(SESSION_COOKIE, id, {
        sameSite: 'Strict',
        maxAge: ABSOLUTE_LIMIT_MS / 1000,
      })
      return reply.header('set-cookie', [clearLogin, sessionCookie]).redirect(transaction.returnTo, 302)
    },
  )

  app.post('/auth/logout', async (request, reply) => {
    const session = await currentSession(request, reply, { activity: false })
    reply.header('set-cookie', clearSession)
    if (session === null) return reply.redirect('/signin', 303)
    await sessions.remove(session.idHash)
    const idToken = open(key, session.idToken)
    try {
      if (idToken === null) throw new Error('unreadable ID token')
      const location = await oidc.endSessionUrl({ idToken, postLogoutRedirectUri: `${config.publicOrigin}/signin` })
      return reply.redirect(location, 303)
    } catch {
      request.log.warn('Keycloak end-session unavailable; local session ended')
      return reply.redirect('/signin', 303)
    }
  })

  /* Reading the account is not activity, so the SPA can poll it without defeating the idle limit. */
  app.get('/api/v1/me', { schema: sessionRoute }, answerMe(false))
  app.post('/api/v1/session/keepalive', { schema: sessionRoute }, answerMe(true))

  return app
}
