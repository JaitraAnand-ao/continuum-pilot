/* IF-27 GET /api/v1/report-history (ST-7): readers only; the role gate in app.ts audits every denial. */
import type { FastifyInstance } from 'fastify'
import type { Clock } from '../clock.js'
import { problemSchema, sendProblem } from '../http/problem.js'
import { buildHistory, DAY_STATUSES, filterHistory, historyRange, type DayStatus } from './rules.js'
import type { ReportHistoryStore } from './store.js'

const querySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
    status: { type: 'string', enum: DAY_STATUSES },
  },
} as const

const nullable = (type: 'string' | 'integer') => ({ type: [type, 'null'] })

const historySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'totalDays', 'firstReportDueAt'],
  properties: {
    totalDays: { type: 'integer' },
    firstReportDueAt: nullable('string'),
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['reportDate', 'status', 'generatedAt', 'signIns', 'failed', 'flagCount', 'emailedAt'],
        properties: {
          reportDate: { type: 'string' },
          status: { type: 'string', enum: DAY_STATUSES },
          generatedAt: nullable('string'),
          signIns: nullable('integer'),
          failed: nullable('integer'),
          flagCount: nullable('integer'),
          emailedAt: nullable('string'),
        },
      },
    },
  },
} as const

export function registerReportHistory(app: FastifyInstance, deps: { clock: Clock; store: ReportHistoryStore }) {
  const { clock, store } = deps
  app.get<{ Querystring: { month?: string; status?: DayStatus } }>(
    '/api/v1/report-history',
    {
      config: { requiredRole: 'reader' },
      schema: {
        querystring: querySchema,
        response: {
          200: historySchema,
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          503: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const now = clock.now()
      const { from, to } = historyRange(now)
      let history
      try {
        const [days, collectionStartedAt] = await Promise.all([
          store.listDays({ from, to }),
          store.collectionStartedAt(),
        ])
        history = buildHistory(days, collectionStartedAt, now)
      } catch {
        /* A store that fails or hands back an unreadable instant is unavailable. Whatever it said stays here: no SQL, host or driver message reaches the caller. */
        return sendProblem(request, reply, 503, {
          type: '/problems/report-store-unavailable',
          title: 'The report store did not respond.',
        })
      }
      return filterHistory(history, request.query)
    },
  )
}
