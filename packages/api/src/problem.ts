/* problem+json with exactly type, title, status and traceId (AC-7); never an upstream or SQL message. */
import type { FastifyReply } from 'fastify'

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
    traceId: { type: 'string' },
  },
} as const

export function sendProblem(reply: FastifyReply, problem: Problem): FastifyReply {
  return reply
    .code(problem.status)
    .header('cache-control', 'no-store')
    .type('application/problem+json')
    .send(JSON.stringify(problem))
}
