/* A test-only report endpoint behind the reader gate (IF-6): ST-1 serves no report, so the tests mount the gate
 * the way a report story will, on the daily report's address, and record which dates reached the handler. */
import { authenticate, requireReader } from '../../src/app.js'
import type { RegisterRoutes } from './harness.js'

export const REPORT_ROUTE = '/api/v1/reports/daily/:date'

export function reportGateRoute(reads: string[] = []): RegisterRoutes {
  return (app, deps) => {
    app.get<{ Params: { date: string } }>(
      REPORT_ROUTE,
      { preHandler: [authenticate(deps, { touch: true }), requireReader(deps)] },
      async (request) => {
        reads.push(request.params.date)
        return { date: request.params.date }
      },
    )
  }
}
