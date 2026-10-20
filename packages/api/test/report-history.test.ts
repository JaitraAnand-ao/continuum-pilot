/* IF-27 GET /api/v1/report-history (ST-7): every day of the last 90 with its status and stored figures, the Month and
 * Status filters, the first-report case, a failing store, and the reader-only gate (AC-1 to AC-7). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StoredReportSummary } from '../src/history/rules.js'
import { ADMIN_ONLY, BOTH, OUTSIDER, READER } from './support/fake-keycloak.js'
import { createHarness, signIn, withSession, type Harness } from './support/harness.js'

let h: Harness
beforeEach(() => {
  h = createHarness('2026-11-01T09:00:00.000Z')
})
afterEach(async () => {
  await h.app.close()
})

const history = (session: string | undefined, query = '') =>
  h.app.inject({ method: 'GET', url: `/api/v1/report-history${query}`, cookies: withSession(session) })

async function reader() {
  const { session } = await signIn(h, READER)
  return session
}

function expectProblem(response: Awaited<ReturnType<typeof history>>, status: number, type: string) {
  expect(response.statusCode).toBe(status)
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/)
  const body = response.json()
  expect(Object.keys(body).sort()).toEqual(['status', 'title', 'traceId', 'type'])
  expect(body).toMatchObject({ type, status })
  expect(body.traceId).toMatch(/^[0-9a-f]{32}$/)
  return body
}

/* October 2026: every day available at 02:xx UTC on D+1, except 7 October generated late at 07:42 UTC and 6 October
 * not generated. September likewise has every day available. */
function seedOctober() {
  const rows: StoredReportSummary[] = []
  for (
    let day = Date.parse('2026-08-03T00:00:00.000Z');
    day <= Date.parse('2026-10-31T00:00:00.000Z');
    day += 86_400_000
  ) {
    const reportDate = new Date(day).toISOString().slice(0, 10)
    if (reportDate === '2026-10-06') continue
    const late = reportDate === '2026-10-07'
    const publishedAt = new Date(
      day + 86_400_000 + (late ? (7 * 60 + 42) * 60_000 : 2 * 3_600_000 + 17_123),
    ).toISOString()
    const n = Number(reportDate.slice(8))
    rows.push({ reportDate, publishedAt, total: 1000 + n, failed: n })
  }
  h.reports.reports = rows
  h.reports.notGenerated = ['2026-10-06']
}

describe('GET /api/v1/report-history', () => {
  it('lists each October day with its status, sign-ins and failed counts, newest first, never cached (AC-1)', async () => {
    seedOctober()
    const response = await history(await reader(), '?month=2026-10')
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    const body = response.json()
    expect(body.totalDays).toBe(90)
    expect(body.firstReportDueAt).toBeNull()
    expect(body.items).toHaveLength(31)
    expect(body.items.map((item: { reportDate: string }) => item.reportDate)).toEqual(
      Array.from({ length: 31 }, (_, i) => `2026-10-${String(31 - i).padStart(2, '0')}`),
    )
    const byDate = new Map<string, Record<string, unknown>>(
      body.items.map((item: { reportDate: string }) => [item.reportDate, item]),
    )
    expect(byDate.get('2026-10-07')).toEqual({
      reportDate: '2026-10-07',
      status: 'generated_late',
      generatedAt: '2026-10-08T07:42:00.000Z',
      signIns: 1007,
      failed: 7,
      flagCount: null,
      emailedAt: null,
    })
    expect(byDate.get('2026-10-06')).toEqual({
      reportDate: '2026-10-06',
      status: 'not_generated',
      generatedAt: null,
      signIns: null,
      failed: null,
      flagCount: null,
      emailedAt: null,
    })
    const statuses = body.items.map((item: { status: string }) => item.status)
    expect(statuses.filter((status: string) => status === 'available')).toHaveLength(29)
  })

  it('returns the stored figures and publication instants unchanged (AC-1)', async () => {
    seedOctober()
    const body = (await history(await reader())).json()
    const served = body.items
      .filter((item: { status: string }) => item.status !== 'not_generated')
      .map((item: { reportDate: string; generatedAt: string; signIns: number; failed: number }) => ({
        reportDate: item.reportDate,
        publishedAt: item.generatedAt,
        total: item.signIns,
        failed: item.failed,
      }))
    expect(served).toEqual([...h.reports.reports].reverse())
  })

  it('asks the store for exactly the 90-day range ending yesterday', async () => {
    await history(await reader())
    expect(h.reports.ranges).toEqual([{ from: '2026-08-03', to: '2026-10-31' }])
  })

  it('serves 11 October as available so its row can open the Daily report (AC-2)', async () => {
    seedOctober()
    const body = (await history(await reader(), '?month=2026-10&status=available')).json()
    expect(body.items).toContainEqual(
      expect.objectContaining({ reportDate: '2026-10-11', status: 'available', signIns: 1011, failed: 11 }),
    )
    expect(body.items.map((item: { reportDate: string }) => item.reportDate)).not.toContain('2026-10-06')
  })

  it('narrows to the late days when Status is Generated late (AC-3)', async () => {
    seedOctober()
    const body = (await history(await reader(), '?month=2026-10&status=generated_late')).json()
    expect(body.items.map((item: { reportDate: string }) => item.reportDate)).toEqual(['2026-10-07'])
    expect(body.totalDays).toBe(90)
  })

  it('moves to the previous month (AC-3)', async () => {
    seedOctober()
    const body = (await history(await reader(), '?month=2026-09')).json()
    expect(body.items).toHaveLength(30)
    expect(body.items[0].reportDate).toBe('2026-09-30')
  })

  it('matches no day for September 2026 with status Not generated, while the range still has days (AC-4)', async () => {
    seedOctober()
    const body = (await history(await reader(), '?month=2026-09&status=not_generated')).json()
    expect(body).toEqual({ items: [], totalDays: 90, firstReportDueAt: null })
  })

  it('before the first report, lists no day and says when the first one is due (AC-5)', async () => {
    h.reports.startedAt = new Date('2026-11-01T08:40:00.000Z')
    const body = (await history(await reader())).json()
    expect(body).toEqual({ items: [], totalDays: 0, firstReportDueAt: '2026-11-03T08:00:00.000Z' })
  })

  it('answers 503 problem+json without the store error when the store fails (AC-6)', async () => {
    h.reports.failure = new Error('connect ECONNREFUSED 10.0.3.7:5432 relation "report" password=hunter2')
    const response = await history(await reader())
    const body = expectProblem(response, 503, '/problems/report-store-unavailable')
    expect(response.body).not.toMatch(/ECONNREFUSED|5432|relation|hunter2/)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(body.title).toBe('The report store did not respond.')
  })

  it('answers 403 to an administrator without the reader role, with no figures, and audits it (AC-7)', async () => {
    seedOctober()
    const { session } = await signIn(h, ADMIN_ONLY)
    h.audit.events.length = 0
    const response = await history(session)
    const body = expectProblem(response, 403, '/problems/forbidden')
    expect(response.body).not.toContain('items')
    expect(h.reports.ranges).toEqual([])
    expect(h.audit.events).toEqual([
      {
        type: 'access-denied',
        account: ADMIN_ONLY.upn,
        reason: 'missing-role',
        requiredRole: 'reader',
        route: '/api/v1/report-history',
        traceId: body.traceId,
        at: '2026-11-01T09:00:00.000Z',
      },
    ])
  })

  it('answers 403 to an account in neither group, and audits it (AC-7)', async () => {
    const { session } = await signIn(h, OUTSIDER)
    h.audit.events.length = 0
    const body = expectProblem(await history(session), 403, '/problems/forbidden')
    expect(h.audit.events).toEqual([
      expect.objectContaining({
        account: OUTSIDER.upn,
        reason: 'missing-role',
        requiredRole: 'reader',
        route: '/api/v1/report-history',
        traceId: body.traceId,
      }),
    ])
  })

  it('clips the oldest month at day 90 of the range (AC-1, AC-3)', async () => {
    seedOctober()
    const body = (await history(await reader(), '?month=2026-08')).json()
    expect(body.items).toHaveLength(29)
    expect(body.items.at(-1).reportDate).toBe('2026-08-03')
  })

  it('answers 503 rather than serve a stored instant it cannot read (AC-6)', async () => {
    h.reports.reports = [{ reportDate: '2026-10-30', publishedAt: 'not-a-time', total: 1, failed: 0 }]
    const response = await history(await reader())
    expectProblem(response, 503, '/problems/report-store-unavailable')
    expect(response.body).not.toContain('not-a-time')
  })

  it('serves a reader who is also a report administrator (AC-7)', async () => {
    const { session } = await signIn(h, BOTH)
    expect((await history(session)).statusCode).toBe(200)
  })

  it('answers 401 without a session, before looking at the query', async () => {
    expectProblem(await history(undefined), 401, '/problems/unauthenticated')
    expectProblem(await history(undefined, '?month=nope'), 401, '/problems/unauthenticated')
    expect(h.reports.ranges).toEqual([])
  })

  it.each([
    ['a month that is not YYYY-MM', '?month=2026-1'],
    ['month 13', '?month=2026-13'],
    ['month 00', '?month=2026-00'],
    ['an unknown status', '?status=late'],
    ['a status in another case', '?status=Available'],
    ['a repeated month', '?month=2026-10&month=2026-11'],
  ])('answers 400 for %s', async (_, query) => {
    const session = await reader()
    expectProblem(await history(session, query), 400, '/problems/invalid-request')
    expect(h.reports.ranges).toEqual([])
  })
})
