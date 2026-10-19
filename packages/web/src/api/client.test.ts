import { describe, expect, it, vi } from 'vitest'
import { NO_ACCESS, problem, READER, SERVER_ERROR, UNAUTHENTICATED, json } from '../testing/fixtures'
import { createApi, loginUrl, LOGIN_PATH, LOGOUT_PATH, ME_PATH, type Fetch } from './client'

const answering = (response: Response | Error) =>
  vi.fn<Fetch>(async () => {
    if (response instanceof Error) throw response
    return response
  })

describe('getMe (IF-4)', () => {
  it('asks /api/v1/me with the session cookie only, never a bearer token (AC-8)', async () => {
    const fetchImpl = answering(json(200, READER))
    await createApi(fetchImpl).getMe()
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(ME_PATH)
    expect(init.method).toBe('GET')
    expect(init.credentials).toBe('same-origin')
    expect(init.cache).toBe('no-store')
    expect(Object.keys(init.headers as Record<string, string>)).toEqual(['accept'])
  })

  it('200 returns the account exactly as the server sent it', async () => {
    expect(await createApi(answering(json(200, READER))).getMe()).toEqual({ kind: 'ok', me: READER })
  })

  it('401 means there is no session', async () => {
    expect(await createApi(answering(problem(UNAUTHENTICATED))).getMe()).toEqual({ kind: 'unauthenticated' })
  })

  it('403 carries the no-access problem untouched (AC-5)', async () => {
    expect(await createApi(answering(problem(NO_ACCESS))).getMe()).toEqual({ kind: 'denied', problem: NO_ACCESS })
  })

  it('a 403 without a problem body is a failure, not a denial', async () => {
    expect(await createApi(answering(new Response('nope', { status: 403 }))).getMe()).toEqual({
      kind: 'failed',
      status: 403,
      traceId: null,
    })
  })

  it('an undocumented status keeps the trace id of its problem', async () => {
    expect(await createApi(answering(problem(SERVER_ERROR))).getMe()).toEqual({
      kind: 'failed',
      status: 503,
      traceId: SERVER_ERROR.traceId,
    })
  })

  it('a 200 that is not JSON is a failure', async () => {
    expect(await createApi(answering(new Response('<html>', { status: 200 }))).getMe()).toEqual({
      kind: 'failed',
      status: 200,
      traceId: null,
    })
  })

  it('a body that is not a problem object yields no trace id', async () => {
    expect(await createApi(answering(json(500, 'oops'))).getMe()).toEqual({
      kind: 'failed',
      status: 500,
      traceId: null,
    })
  })

  it('a network failure is a failure with no status', async () => {
    expect(await createApi(answering(new TypeError('offline'))).getMe()).toEqual({
      kind: 'failed',
      status: null,
      traceId: null,
    })
  })
})

describe('signOut (IF-5)', () => {
  it('posts to /auth/logout with the session cookie', async () => {
    const fetchImpl = answering(new Response(null, { status: 204 }))
    expect(await createApi(fetchImpl).signOut()).toBe(true)
    expect(fetchImpl).toHaveBeenCalledWith(LOGOUT_PATH, { method: 'POST', credentials: 'same-origin' })
  })

  it('a session that had already ended counts as signed out', async () => {
    expect(await createApi(answering(problem(UNAUTHENTICATED))).signOut()).toBe(true)
  })

  it('a server error is reported as not signed out', async () => {
    expect(await createApi(answering(problem(SERVER_ERROR))).signOut()).toBe(false)
  })

  it('a network failure is reported as not signed out', async () => {
    expect(await createApi(answering(new TypeError('offline'))).signOut()).toBe(false)
  })
})

describe('loginUrl (IF-1)', () => {
  it('without a return path is the bare login route', () => {
    expect(loginUrl()).toBe(LOGIN_PATH)
  })

  it('carries a same-origin return path', () => {
    expect(loginUrl('/reports/daily?date=2026-10-18')).toBe(
      '/auth/login?returnTo=%2Freports%2Fdaily%3Fdate%3D2026-10-18',
    )
    expect(loginUrl('/')).toBe('/auth/login?returnTo=%2F')
  })

  it.each(['https://evil.example/', '//evil.example/', '/\\evil.example', 'reports', `/${'a'.repeat(512)}`])(
    'drops the return path %s the contract refuses',
    (returnTo) => {
      expect(loginUrl(returnTo)).toBe(LOGIN_PATH)
    },
  )
})
