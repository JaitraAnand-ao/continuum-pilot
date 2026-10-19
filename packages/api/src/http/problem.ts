/* problem+json carrying only type, title, status and traceId (AC-7): no upstream or internal message ever reaches it. */
import { randomBytes } from 'node:crypto'

export interface Problem {
  type: string
  title: string
  status: number
  traceId: string
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json'

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

const TITLES = {
  'invalid-request': [400, 'The request is not valid.'],
  'invalid-login-transaction': [400, 'The sign-in could not be verified. Start again.'],
  unauthenticated: [401, 'Sign in to continue.'],
  forbidden: [403, 'You do not have access to this resource.'],
  'not-found': [404, 'Not found.'],
  internal: [500, 'Something went wrong.'],
  'idp-unavailable': [503, 'Sign-in is unavailable right now. Try again shortly.'],
} as const satisfies Record<string, readonly [number, string]>

export type ProblemKind = keyof typeof TITLES

export function problem(kind: ProblemKind, traceId: string): Problem {
  const [status, title] = TITLES[kind]
  return { type: `/problems/${kind}`, title, status, traceId }
}

export function noAccessProblem(account: string, traceId: string): Problem {
  return { type: '/problems/no-access', title: `You don't have access. Signed in as ${account}.`, status: 403, traceId }
}

/* The W3C traceparent's trace ID when the caller sent one, otherwise a fresh one. */
export function traceIdFrom(traceparent: string | string[] | undefined): string {
  const header = Array.isArray(traceparent) ? traceparent[0] : traceparent
  const match = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(header ?? '')
  if (match?.[1] && !/^0+$/.test(match[1])) return match[1]
  return randomBytes(16).toString('hex')
}
