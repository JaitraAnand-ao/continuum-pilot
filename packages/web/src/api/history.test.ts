import { describe, expect, it, vi } from 'vitest'
import { json, problem, SERVER_ERROR, UNAUTHENTICATED } from '../testing/fixtures'
import { BAD_REQUEST, HISTORY, NO_REPORTS_YET, NOT_A_READER } from '../testing/history'
import { createApi, REPORT_HISTORY_PATH, type Fetch } from './client'

const answering = (response: Response | Error) =>
  vi.fn<Fetch>(async () => {
    if (response instanceof Error) throw response
    return response
  })

describe('getReportHistory (IF-27)', () => {
  it('asks /api/v1/report-history with the session cookie only, never a bearer token', async () => {
    const fetchImpl = answering(json(200, HISTORY))
    await createApi(fetchImpl).getReportHistory()
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(REPORT_HISTORY_PATH)
    expect(url).toBe('/api/v1/report-history')
    expect(init.method).toBe('GET')
    expect(init.credentials).toBe('same-origin')
    expect(init.cache).toBe('no-store')
    expect(Object.keys(init.headers as Record<string, string>)).toEqual(['accept'])
  })

  it('200 returns the days exactly as the server sent them', async () => {
    expect(await createApi(answering(json(200, HISTORY))).getReportHistory()).toEqual({ kind: 'ok', history: HISTORY })
  })

  it('200 before the first report keeps when it is due', async () => {
    expect(await createApi(answering(json(200, NO_REPORTS_YET))).getReportHistory()).toEqual({
      kind: 'ok',
      history: NO_REPORTS_YET,
    })
  })

  it('401 means there is no session', async () => {
    expect(await createApi(answering(problem(UNAUTHENTICATED))).getReportHistory()).toEqual({
      kind: 'unauthenticated',
    })
  })

  it('403 means the session lacks the reader role (AC-7)', async () => {
    expect(await createApi(answering(problem(NOT_A_READER))).getReportHistory()).toEqual({ kind: 'forbidden' })
  })

  it('400 is a failure carrying its trace id', async () => {
    expect(await createApi(answering(problem(BAD_REQUEST))).getReportHistory()).toEqual({
      kind: 'failed',
      status: 400,
      traceId: BAD_REQUEST.traceId,
    })
  })

  it('503 is a failure carrying its trace id', async () => {
    expect(await createApi(answering(problem(SERVER_ERROR))).getReportHistory()).toEqual({
      kind: 'failed',
      status: 503,
      traceId: SERVER_ERROR.traceId,
    })
  })

  it('a 200 that is not JSON is a failure', async () => {
    expect(await createApi(answering(new Response('<html>', { status: 200 }))).getReportHistory()).toEqual({
      kind: 'failed',
      status: 200,
      traceId: null,
    })
  })

  it('a network failure is a failure with no status', async () => {
    expect(await createApi(answering(new TypeError('offline'))).getReportHistory()).toEqual({
      kind: 'failed',
      status: null,
      traceId: null,
    })
  })
})
