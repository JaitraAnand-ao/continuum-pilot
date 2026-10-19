/* ST-1 AC-5 and AC-7 at the reader gate (IF-6) every report endpoint mounts: no session is 401; a session without
 * the reader role is 403 as problem+json carrying only type, title, status and traceId, with no report data, and
 * the denial is audited. ST-1 serves no report, so the gate is exercised on a test-only route. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadContract, responseSchema, violations } from './support/contract.js'
import { ADMIN_ONLY, OUTSIDER, READER, READER_ADMIN, signIn, startHarness, type Harness } from './support/harness.js'
import { REPORT_ROUTE, reportGateRoute } from './support/report-gate.js'

const IF6 = loadContract('IF-6')
const unauthenticated = responseSchema(IF6, '/api/v1/reports/daily/{date}', 'get', 401, 'application/problem+json')
const forbidden = responseSchema(IF6, '/api/v1/reports/daily/{date}', 'get', 403, 'application/problem+json')
const reads: string[] = []
let harness: Harness

beforeEach(async () => {
  reads.length = 0
  harness = await startHarness({ routes: reportGateRoute(reads) })
})
afterEach(async () => {
  await harness.close()
})

const yesterday = (cookie?: string) =>
  harness.app.inject({ url: '/api/v1/reports/daily/2026-10-18', ...(cookie ? { headers: { cookie } } : {}) })

describe('the reader gate on a report endpoint', () => {
  it('answers 401 problem+json with no session, or an unknown one, without reaching the report', async () => {
    for (const cookie of [undefined, '__Host-sr_session=not-a-session']) {
      const response = await yesterday(cookie)
      expect(response.statusCode).toBe(401)
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/)
      const body = response.json()
      expect(Object.keys(body).sort()).toEqual(['status', 'title', 'traceId', 'type'])
      expect(body.type).toBe('/problems/unauthenticated')
      expect(await violations(unauthenticated, body)).toEqual([])
    }
    expect(reads).toEqual([])
    expect(harness.audit.events).toEqual([])
  })

  it('answers 403 to an administrator without the reader role: only type, title, status and traceId', async () => {
    const { sessionCookie } = await signIn(harness, ADMIN_ONLY)
    const response = await yesterday(sessionCookie)
    expect(response.statusCode).toBe(403)
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/)
    const body = response.json()
    expect(Object.keys(body).sort()).toEqual(['status', 'title', 'traceId', 'type'])
    expect(body).toMatchObject({ type: '/problems/forbidden', status: 403 })
    expect(body.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(await violations(forbidden, body)).toEqual([])
    expect(reads).toEqual([])
    expect(harness.audit.events).toEqual([
      {
        type: 'access-denied',
        account: 'j.lee@contoso.com',
        route: REPORT_ROUTE,
        traceId: body.traceId,
        at: harness.clock.now(),
      },
    ])
  })

  it('answers 403 with no report data to an account in neither group, by the report’s address (AC-5)', async () => {
    const { sessionCookie } = await signIn(harness, OUTSIDER)
    const response = await yesterday(sessionCookie)
    expect(response.statusCode).toBe(403)
    const body = response.json()
    expect(await violations(forbidden, body)).toEqual([])
    expect(response.body).not.toContain('2026-10-18')
    expect(reads).toEqual([])
    expect(harness.audit.events.map((event) => [event.type, 'account' in event && event.account])).toEqual([
      ['access-denied', 'k.brown@contoso.com'],
    ])
  })

  it('lets a reader, and a reader who is also an administrator, through to the report', async () => {
    for (const claims of [READER, READER_ADMIN]) {
      const { sessionCookie } = await signIn(harness, claims)
      expect((await yesterday(sessionCookie)).statusCode).toBe(200)
    }
    expect(reads).toEqual(['2026-10-18', '2026-10-18'])
    expect(harness.audit.events).toEqual([])
  })
})
