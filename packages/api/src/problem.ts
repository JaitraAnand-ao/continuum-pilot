/* problem+json carrying only type, title, status and traceId (AC-7): never an upstream or SQL message. */
import { randomBytes } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'

export interface Problem {
  type: string
  title: string
  status: number
  traceId: string
}

export const problemSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'title', 'status', 'traceId'],
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'integer' },
    traceId: { type: 'string', pattern: '^[0-9a-f]{32}$' },
  },
} as const

const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/

/** The caller's W3C trace ID when it sent a valid traceparent, otherwise a fresh one. */
export function traceIdFrom(traceparent: string | string[] | undefined): string {
  const match = typeof traceparent === 'string' ? TRACEPARENT.exec(traceparent) : null
  const traceId = match?.[1]
  return traceId !== undefined && !/^0+$/.test(traceId) ? traceId : randomBytes(16).toString('hex')
}

export const PROBLEMS = {
  invalidRequest: { status: 400, type: '/problems/invalid-request', title: 'The request is not valid.' },
  unauthenticated: { status: 401, type: '/problems/unauthenticated', title: 'Sign in to continue.' },
  forbidden: { status: 403, type: '/problems/forbidden', title: 'Your account does not have the role this needs.' },
  notFound: { status: 404, type: '/problems/not-found', title: 'Nothing is at this address.' },
  internal: { status: 500, type: '/problems/internal', title: 'Something went wrong.' },
  identityProviderUnavailable: {
    status: 503,
    type: '/problems/identity-provider-unavailable',
    title: 'Sign-in with Microsoft Entra ID is unavailable. Try again shortly.',
  },
} as const

export function noAccessProblem(account: string): Omit<Problem, 'traceId'> {
  return { status: 403, type: '/problems/no-access', title: `You don't have access. Signed in as ${account}.` }
}

export function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  problem: Omit<Problem, 'traceId'>,
): FastifyReply {
  const body: Problem = { type: problem.type, title: problem.title, status: problem.status, traceId: request.traceId }
  return reply.code(problem.status).type('application/problem+json').header('cache-control', 'no-store').send(body)
}
