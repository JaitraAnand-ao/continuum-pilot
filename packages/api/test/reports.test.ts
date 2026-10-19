/* ST-1 AC-5 and AC-7 on a report endpoint: no session is 401; a session without the reader role is 403 as
 * problem+json carrying only type, title, status and traceId, with no report data, and the denial is audited. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ADMIN_ONLY, OUTSIDER, READER, READER_ADMIN, signIn, startHarness, type Harness } from './support/harness.js'

const FIGURES = { date: '2026-10-18', failedSignIns: 42 }
const reads: string[] = []
let harness: Harness

beforeEach(async () => {
  reads.length = 0
  harness = await startHarness({
    reports: { daily: async (date) => (reads.push(date), date === FIGURES.date ? FIGURES : undefined) },
  })
})
afterEach(async () => {
  await harness.close()
})

const yesterday = (cookie?: string) =>
  harness.app.inject({ url: '/api/v1/reports/daily/2026-10-18', ...(cookie ? { headers: { cookie } } : {}) })

describe('GET /api/v1/reports/daily/:date', () => {
  it('answers 401 problem+json with no session, without reading the report', async () => {
    const response = await yesterday()
    expect(response.statusCode).toBe(401)
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/)
    expect(Object.keys(response.json()).sort()).toEqual(['status', 'title', 'traceId', 'type'])
    expect(reads).toEqual([])
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
    expect(reads).toEqual([])
    expect(harness.audit.events).toEqual([
      {
        type: 'access-denied',
        account: 'j.lee@contoso.com',
        route: '/api/v1/reports/daily/:date',
        traceId: body.traceId,
        at: harness.clock.now(),
      },
    ])
  })

  it('answers 403 with no report figures to an account in neither group, by the report’s address (AC-5)', async () => {
    const { sessionCookie } = await signIn(harness, OUTSIDER)
    const response = await yesterday(sessionCookie)
    expect(response.statusCode).toBe(403)
    expect(response.body).not.toContain('failedSignIns')
    expect(reads).toEqual([])
    expect(harness.audit.events.map((event) => [event.type, 'account' in event && event.account])).toEqual([
      ['access-denied', 'k.brown@contoso.com'],
    ])
  })

  it('serves the stored report to a reader and to a reader who is also an administrator', async () => {
    for (const claims of [READER, READER_ADMIN]) {
      const { sessionCookie } = await signIn(harness, claims)
      const response = await yesterday(sessionCookie)
      expect(response.statusCode).toBe(200)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.json()).toEqual(FIGURES)
    }
  })

  it('answers 404 problem+json for a day with no report, and 400 for a malformed date', async () => {
    const { sessionCookie } = await signIn(harness, READER)
    const missing = await harness.app.inject({
      url: '/api/v1/reports/daily/2026-10-17',
      headers: { cookie: sessionCookie },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().type).toBe('/problems/not-found')
    const malformed = await harness.app.inject({
      url: '/api/v1/reports/daily/yesterday',
      headers: { cookie: sessionCookie },
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json().type).toBe('/problems/invalid-request')
  })

  it('answers 500 problem+json without the internal message when the report store fails', async () => {
    await harness.close()
    harness = await startHarness({
      reports: { daily: async () => Promise.reject(new Error('relation "report" does not exist')) },
    })
    const { sessionCookie } = await signIn(harness, READER)
    const response = await yesterday(sessionCookie)
    expect(response.statusCode).toBe(500)
    expect(response.json()).toMatchObject({ type: '/problems/internal', status: 500 })
    expect(response.body).not.toContain('relation')
  })

  it('answers 404 while no report store is wired', async () => {
    await harness.close()
    harness = await startHarness()
    const { sessionCookie } = await signIn(harness, READER)
    expect((await yesterday(sessionCookie)).statusCode).toBe(404)
  })
})
