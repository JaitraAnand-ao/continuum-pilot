/* IF-4 GET /api/v1/me: the signed-in account, its roles and the AD-5 limits, for navigation and the idle warning. */
import type { FastifyInstance } from 'fastify'
import { ROLES } from './access.js'
import { problemSchema } from './problem.js'
import { sessionExpiries } from './session/policy.js'
import type { StoredSession } from './session/store.js'

const meSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['account', 'displayName', 'roles', 'authTime', 'idleExpiresAt', 'absoluteExpiresAt'],
  properties: {
    account: { type: 'string' },
    displayName: { type: 'string' },
    roles: { type: 'array', uniqueItems: true, items: { type: 'string', enum: [...ROLES] } },
    authTime: { type: 'string', format: 'date-time' },
    idleExpiresAt: { type: 'string', format: 'date-time' },
    absoluteExpiresAt: { type: 'string', format: 'date-time' },
  },
} as const

export function registerMeRoute(app: FastifyInstance): void {
  app.get(
    '/api/v1/me',
    {
      config: { access: 'signed-in' },
      schema: {
        response: { 200: meSchema, 401: problemSchema, 403: problemSchema },
      },
    },
    async (request, reply) => {
      const session = request.session as StoredSession
      const { idleExpiresAt, absoluteExpiresAt } = sessionExpiries(session)
      reply.header('cache-control', 'no-store')
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
}
