/* RFC 9457 problem details, limited to type, title, status and traceId so nothing upstream can leak (ST-1 AC-7). */
import { randomBytes } from 'node:crypto'
import type { FastifyReply } from 'fastify'

export interface Problem {
  type: string
  title: string
  status: number
}

export const problems = {
  invalidRequest: { type: '/problems/invalid-request', title: 'Invalid request', status: 400 },
  invalidLoginTransaction: {
    type: '/problems/invalid-login-transaction',
    title: 'Sign-in could not be verified',
    status: 400,
  },
  unauthenticated: { type: '/problems/unauthenticated', title: 'Sign-in required', status: 401 },
  forbidden: { type: '/problems/forbidden', title: 'Forbidden', status: 403 },
  identityProviderUnavailable: {
    type: '/problems/identity-provider-unavailable',
    title: 'Sign-in is unavailable',
    status: 503,
  },
  internal: { type: '/problems/internal', title: 'Internal error', status: 500 },
} as const satisfies Record<string, Problem>

export function noAccess(account: string): Problem {
  return { type: '/problems/no-access', title: `You don't have access. Signed in as ${account}.`, status: 403 }
}

export const problemSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'title', 'status', 'traceId'],
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'integer' },
    traceId: { type: 'string' },
  },
} as const

const TRACEPARENT = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/

/* The W3C trace ID the caller propagated, or a fresh one so every problem can be correlated. */
export function traceIdFrom(traceparent: string | string[] | undefined): string {
  const match = typeof traceparent === 'string' ? TRACEPARENT.exec(traceparent) : null
  const id = match?.[1]
  return id !== undefined && !/^0+$/.test(id) ? id : randomBytes(16).toString('hex')
}

export function sendProblem(reply: FastifyReply, problem: Problem): FastifyReply {
  return reply
    .code(problem.status)
    .type('application/problem+json')
    .send({ type: problem.type, title: problem.title, status: problem.status, traceId: reply.request.traceId })
}
