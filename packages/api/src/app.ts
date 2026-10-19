/* CMP-2, the BFF: sign-in (IF-1), its callback (IF-2), sign-out (IF-3), the current account (IF-4), the idle
 * keep-alive (IF-5) and the reader gate every report endpoint mounts (IF-6). Tokens never leave the server; the browser holds only the Strict
 * session cookie (AD-5). The server decides access on every route (AD-7). */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import type { AuditSink } from './audit.js'
import { canReadReports, accessFor, rolesFromClaim } from './auth/roles.js'
import { IdpUnavailableError, type OidcClient } from './auth/oidc.js'
import type { Clock } from './clock.js'
import { open, pkceChallenge, randomToken, safeEqual, seal, sha256Hex } from './crypto.js'
import {
  LOGIN_COOKIE,
  LOGIN_TRANSACTION_SECONDS,
  SESSION_COOKIE,
  clearLoginCookie,
  clearSessionCookie,
  loginCookie,
  readCookie,
  sessionCookie,
} from './http/cookies.js'
import {
  PROBLEM_CONTENT_TYPE,
  noAccessProblem,
  problem,
  problemSchema,
  traceIdFrom,
  type Problem,
  type ProblemKind,
} from './http/problem.js'
import type { Secret } from './secret.js'
import { absoluteExpiresAt, idleExpiresAt, sessionState } from './session/policy.js'
import type { SessionRecord, SessionStore } from './session/store.js'

export interface AppDependencies {
  oidc: OidcClient
  sessions: SessionStore
  audit: AuditSink
  clock: Clock
  sessionKey: Secret<Buffer>
}

interface LoginTransaction {
  state: string
  nonce: string
  verifier: string
  returnTo: string
  startedAt: number
}

interface ActiveSession {
  idHash: string
  record: SessionRecord
}

declare module 'fastify' {
  interface FastifyRequest {
    traceId: string
    activeSession: ActiveSession | undefined
  }
}

const LOGIN_AAD = 'sr_login'
const RETURN_TO_PATTERN = '^/[^/\\\\].*$|^/$'
const ENTRA_CODE = /AADSTS\d{4,6}/
const OAUTH_ERROR = /^[A-Za-z0-9_.-]{1,64}$/

const problemResponses = (...statuses: number[]) =>
  Object.fromEntries(statuses.map((status) => [status, problemSchema]))

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

const sendProblem = (reply: FastifyReply, body: Problem) =>
  reply.code(body.status).type(PROBLEM_CONTENT_TYPE).header('cache-control', 'no-store').send(body)
const fail = (request: FastifyRequest, reply: FastifyReply, kind: ProblemKind) =>
  sendProblem(reply, problem(kind, request.traceId))

/* Resolves the session cookie; an unknown, idle-expired or absolute-expired session answers 401. */
export const authenticate =
  (deps: Pick<AppDependencies, 'sessions' | 'clock'>, options: { touch: boolean }) =>
  async (request: FastifyRequest, reply: FastifyReply) => {
    const id = readCookie(request.headers.cookie, SESSION_COOKIE)
    const idHash = id === undefined ? undefined : sha256Hex(id)
    const record = idHash === undefined ? undefined : await deps.sessions.find(idHash)
    if (!idHash || !record) return fail(request, reply, 'unauthenticated')
    const now = deps.clock.now()
    if (sessionState(record, now) !== 'active') {
      await deps.sessions.delete(idHash)
      return fail(request, reply.header('set-cookie', clearSessionCookie()), 'unauthenticated')
    }
    if (options.touch) {
      await deps.sessions.touch(idHash, now)
      record.lastSeenAt = now
    }
    request.activeSession = { idHash, record }
  }

const deny = async (
  deps: Pick<AppDependencies, 'audit' | 'clock'>,
  request: FastifyRequest,
  reply: FastifyReply,
  body: Problem,
) => {
  const account = request.activeSession?.record.account ?? 'unknown'
  await deps.audit.record({
    type: 'access-denied',
    account,
    route: request.routeOptions.url ?? request.url,
    traceId: request.traceId,
    at: deps.clock.now(),
  })
  return sendProblem(reply, body)
}

/* The reader gate (IF-6), mounted after authenticate on every report endpoint; a denial is audited. */
export const requireReader =
  (deps: Pick<AppDependencies, 'audit' | 'clock'>) => async (request: FastifyRequest, reply: FastifyReply) => {
    if (!canReadReports(request.activeSession?.record.roles ?? [])) {
      return deny(deps, request, reply, problem('forbidden', request.traceId))
    }
  }

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: true, ajv: { customOptions: { removeAdditional: false } } })

  app.decorateRequest('traceId', '')
  app.decorateRequest('activeSession', undefined)
  app.addHook('onRequest', async (request) => {
    request.traceId = traceIdFrom(request.headers.traceparent)
  })

  app.setErrorHandler((error: { validation?: unknown }, request, reply) =>
    fail(request, reply, error.validation ? 'invalid-request' : 'internal'),
  )
  app.setNotFoundHandler((request, reply) => fail(request, reply, 'not-found'))

  const requireAnyRole = async (request: FastifyRequest, reply: FastifyReply) => {
    const record = request.activeSession?.record
    if (record && accessFor(record.roles) === 'none') {
      return deny(deps, request, reply, noAccessProblem(record.account, request.traceId))
    }
  }

  const sessionView = (record: SessionRecord) => ({
    account: record.account,
    displayName: record.displayName,
    roles: record.roles,
    authTime: record.authTime.toISOString(),
    idleExpiresAt: idleExpiresAt(record).toISOString(),
    absoluteExpiresAt: absoluteExpiresAt(record).toISOString(),
  })

  app.get<{ Querystring: { returnTo?: string; maxAge?: number } }>(
    '/auth/login',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            returnTo: { type: 'string', pattern: RETURN_TO_PATTERN, maxLength: 512 },
            maxAge: { type: 'integer', minimum: 0, maximum: 900 },
          },
        },
        response: problemResponses(400, 503),
      },
    },
    async (request, reply) => {
      const transaction: LoginTransaction = {
        state: randomToken(),
        nonce: randomToken(),
        verifier: randomToken(48),
        returnTo: request.query.returnTo ?? '/',
        startedAt: deps.clock.now().getTime(),
      }
      let location: string
      try {
        location = await deps.oidc.authorizationUrl({
          state: transaction.state,
          nonce: transaction.nonce,
          codeChallenge: pkceChallenge(transaction.verifier),
          ...(request.query.maxAge === undefined ? {} : { maxAge: request.query.maxAge }),
        })
      } catch (error) {
        if (error instanceof IdpUnavailableError) return fail(request, reply, 'idp-unavailable')
        throw error
      }
      const sealed = seal(deps.sessionKey, JSON.stringify(transaction), LOGIN_AAD)
      return reply.header('set-cookie', loginCookie(sealed)).header('cache-control', 'no-store').redirect(location)
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
        response: problemResponses(400),
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store')
      const cleared = [clearLoginCookie()]
      const now = deps.clock.now()
      const sealed = readCookie(request.headers.cookie, LOGIN_COOKIE)
      const transaction = parseTransaction(sealed && open(deps.sessionKey, sealed, LOGIN_AAD))
      const fresh = transaction && now.getTime() - transaction.startedAt < LOGIN_TRANSACTION_SECONDS * 1000
      const { code, state } = request.query
      /* Only a callback answering this browser's own sign-in is acted on, an error included: an error without the
       * transaction cookie, or with another state, is refused and writes no audit event. */
      if (!transaction || !fresh || !state || !safeEqual(state, transaction.state)) {
        return fail(request, reply.header('set-cookie', cleared), 'invalid-login-transaction')
      }

      if (request.query.error !== undefined) {
        const entra = ENTRA_CODE.exec(request.query.error_description ?? '')?.[0]
        const errorCode = entra ?? (OAUTH_ERROR.test(request.query.error) ? request.query.error : 'unknown_error')
        const reference = randomToken(12)
        await deps.audit.record({ type: 'sign-in-failed', errorCode, reference, traceId: request.traceId, at: now })
        const target = new URLSearchParams({ code: errorCode, ref: reference, at: now.toISOString() })
        return reply.header('set-cookie', cleared).redirect(`/signin/error?${target.toString()}`)
      }

      if (!code) return fail(request, reply.header('set-cookie', cleared), 'invalid-login-transaction')

      let identity
      let refreshToken: string
      try {
        const tokens = await deps.oidc.exchangeCode(code, transaction.verifier)
        identity = await deps.oidc.verifyIdToken(tokens.idToken, transaction.nonce, now)
        refreshToken = tokens.refreshToken
      } catch {
        return fail(request, reply.header('set-cookie', cleared), 'invalid-login-transaction')
      }

      /* Rotation at login: any session the browser already held ends; a new ID is issued. */
      const previous = readCookie(request.headers.cookie, SESSION_COOKIE)
      if (previous !== undefined) await deps.sessions.delete(sha256Hex(previous))
      const id = randomToken()
      const idHash = sha256Hex(id)
      await deps.sessions.create({
        idHash,
        account: identity.account,
        displayName: identity.displayName,
        roles: rolesFromClaim(identity.roles),
        authTime: identity.authTime,
        createdAt: now,
        lastSeenAt: now,
        refreshTokenCiphertext: seal(deps.sessionKey, refreshToken, idHash),
      })
      return reply.header('set-cookie', [...cleared, sessionCookie(id)]).redirect(transaction.returnTo)
    },
  )

  app.post(
    '/auth/logout',
    {
      schema: { response: { 204: { type: 'null' }, ...problemResponses(401) } },
      preHandler: authenticate(deps, { touch: false }),
    },
    async (request, reply) => {
      const { idHash, record } = request.activeSession as ActiveSession
      await deps.sessions.delete(idHash)
      const refreshToken = open(deps.sessionKey, record.refreshTokenCiphertext, idHash)
      if (refreshToken !== undefined) {
        /* The local session is already over; a Keycloak that cannot be reached must not keep the user signed in here. */
        await deps.oidc.endSession(refreshToken).catch(() => undefined)
      }
      return reply.header('set-cookie', clearSessionCookie()).header('cache-control', 'no-store').code(204).send()
    },
  )

  app.get(
    '/api/v1/me',
    {
      schema: { response: { 200: meSchema, ...problemResponses(401, 403) } },
      preHandler: [authenticate(deps, { touch: false }), requireAnyRole],
    },
    async (request, reply) => {
      const { record } = request.activeSession as ActiveSession
      return reply.header('cache-control', 'no-store').send(sessionView(record))
    },
  )

  app.post(
    '/api/v1/session/keepalive',
    {
      schema: { response: { 200: meSchema, ...problemResponses(401, 403) } },
      preHandler: [authenticate(deps, { touch: true }), requireAnyRole],
    },
    async (request, reply) => {
      const { record } = request.activeSession as ActiveSession
      return reply.header('cache-control', 'no-store').send(sessionView(record))
    },
  )

  return app
}

function parseTransaction(raw: string | undefined): LoginTransaction | undefined {
  if (!raw) return undefined
  const value = JSON.parse(raw) as LoginTransaction
  return typeof value.state === 'string' && typeof value.startedAt === 'number' ? value : undefined
}
