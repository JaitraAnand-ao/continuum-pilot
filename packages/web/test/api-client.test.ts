import { describe, expect, it, vi } from 'vitest'
import { getMe, loginUrl, logout, traceparent, type FetchLike } from '../src/api/client'
import { jsonResponse, meFor, NO_ACCESS, UNAUTHORIZED } from './fixtures'

const fetchReturning = (response: Response | Error) =>
  vi.fn<FetchLike>(() => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response)))

describe('IF-4 getMe', () => {
  it('asks /api/v1/me with the session cookie only and a trace context', async () => {
    const fetchImpl = fetchReturning(jsonResponse(200, meFor(['reader'])))
    await getMe(fetchImpl)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('/api/v1/me')
    expect(init.method).toBe('GET')
    expect(init.credentials).toBe('same-origin')
    const headers = init.headers as Record<string, string>
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain('authorization')
  })

  it('returns the account for 200', async () => {
    const me = meFor(['reader', 'config.read'])
    expect(await getMe(fetchReturning(jsonResponse(200, me)))).toEqual({ status: 200, me })
  })

  it('returns 401 when there is no session', async () => {
    expect(await getMe(fetchReturning(jsonResponse(401, UNAUTHORIZED, 'application/problem+json')))).toEqual({
      status: 401,
    })
  })

  it('returns the no-access problem for 403', async () => {
    expect(await getMe(fetchReturning(jsonResponse(403, NO_ACCESS, 'application/problem+json')))).toEqual({
      status: 403,
      problem: NO_ACCESS,
    })
  })

  it.each([
    ['a 200 body outside the contract', jsonResponse(200, { account: 'x' })],
    ['a 200 with an unknown role', jsonResponse(200, { ...meFor(['reader']), roles: ['owner'] })],
    ['a 200 with a bad date', jsonResponse(200, { ...meFor(['reader']), idleExpiresAt: 'soon' })],
    ['a 403 that is not the no-access problem', jsonResponse(403, { ...NO_ACCESS, title: 'Forbidden' })],
    ['a 403 without a body', new Response('', { status: 403 })],
    ['a 500', jsonResponse(500, { title: 'boom' })],
    ['a 502 from the edge', new Response('<html>Bad gateway</html>', { status: 502 })],
    ['a network failure', new TypeError('Failed to fetch')],
  ])('returns error for %s', async (_, response) => {
    expect(await getMe(fetchReturning(response))).toEqual({ status: 'error' })
  })

  it('uses the browser fetch by default', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(401, UNAUTHORIZED))
    expect(await getMe()).toEqual({ status: 401 })
    expect(spy).toHaveBeenCalledWith('/api/v1/me', expect.objectContaining({ credentials: 'same-origin' }))
    spy.mockRestore()
  })
})

describe('IF-1 loginUrl', () => {
  it('starts sign-in at /auth/login', () => {
    expect(loginUrl()).toBe('/auth/login')
    expect(loginUrl('/')).toBe('/auth/login')
  })

  it('carries a same-origin return path', () => {
    expect(loginUrl('/reports/daily?date=2026-10-18')).toBe(
      '/auth/login?returnTo=%2Freports%2Fdaily%3Fdate%3D2026-10-18',
    )
  })

  it.each(['//evil.example', '/\\evil.example', 'https://evil.example/', 'reports', `/${'a'.repeat(512)}`])(
    'drops a return path the contract refuses: %s',
    (returnTo) => {
      expect(loginUrl(returnTo)).toBe('/auth/login')
    },
  )
})

describe('IF-5 logout', () => {
  it('posts to /auth/logout with the session cookie', async () => {
    const fetchImpl = fetchReturning(new Response(null, { status: 204 }))
    expect(await logout(fetchImpl)).toBe(true)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('/auth/logout')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('same-origin')
  })

  it('treats an already-ended session as signed out', async () => {
    expect(await logout(fetchReturning(jsonResponse(401, UNAUTHORIZED)))).toBe(true)
  })

  it('reports a failed sign-out', async () => {
    expect(await logout(fetchReturning(new Response(null, { status: 500 })))).toBe(false)
    expect(await logout(fetchReturning(new TypeError('Failed to fetch')))).toBe(false)
  })

  it('uses the browser fetch by default', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    expect(await logout()).toBe(true)
    spy.mockRestore()
  })
})

describe('traceparent', () => {
  it('is fresh for every call', () => {
    expect(traceparent()).not.toBe(traceparent())
  })
})
