/* RFC 9457 problem+json, carrying only type, title, status and traceId (ST-1 AC-7). */
import { STATUS_CODES } from 'node:http'
import type { FastifyReply, FastifyRequest } from 'fastify'

export interface Problem {
  type: string
  title: string
  status: number
  traceId: string
}

const TYPES: Record<number, string> = {
  400: '/problems/invalid-request',
  401: '/problems/unauthenticated',
  403: '/problems/forbidden',
  404: '/problems/not-found',
  500: '/problems/internal',
  503: '/problems/identity-provider-unavailable',
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

export function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  overrides: Partial<Pick<Problem, 'type' | 'title'>> = {},
): FastifyReply {
  const problem: Problem = {
    type: overrides.type ?? TYPES[status] ?? `/problems/http-${status}`,
    title: overrides.title ?? STATUS_CODES[status] ?? 'Error',
    status,
    traceId: request.id,
  }
  return reply.code(status).type('application/problem+json').send(problem)
}
