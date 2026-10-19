import { describe, expect, it, vi } from 'vitest'
import { loadContract, validate } from '../test-support/contract'
import { jsonResponse, noAccessProblem, readerMe, unauthenticatedProblem } from '../test-support/fixtures'
import { createApiClient, isMe, isProblem, loginUrl, type Fetch } from './client'

const if1 = loadContract('IF-1')

const clientAnswering = (response: Response | Error) => {
  const fetchImpl = vi.fn<Fetch>(async () => {
    if (response instanceof Error) throw response
    return response
  })
  return { fetchImpl, client: createApiClient(fetchImpl) }
}

describe('IF-4 GET /api/v1/me', () => {
  it('sends only the same-origin session cookie, never a bearer token (AC-8)', async () => {
    const { fetchImpl, client } = clientAnswering(jsonResponse(200, readerMe))
    await client.getMe()
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('/api/v1/me')
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' })
    expect(JSON.stringify(init?.headers)).not.toMatch(/authorization/i)
  })

  it('200 returns the account and roles exactly as the BFF sent them', async () => {
    const { client } = clientAnswering(jsonResponse(200, readerMe))
    expect(await client.getMe()).toEqual({ status: 'ok', me: readerMe })
  })

  it('401 means there is no session (AC-7)', async () => {
    const { client } = clientAnswering(jsonResponse(401, unauthenticatedProblem, 'application/problem+json'))
    expect(await client.getMe()).toEqual({ status: 'unauthenticated' })
  })

  it('403 carries the no-access problem naming the account (AC-5)', async () => {
    const { client } = clientAnswering(jsonResponse(403, noAccessProblem, 'application/problem+json'))
    expect(await client.getMe()).toEqual({ status: 'forbidden', problem: noAccessProblem })
  })

  it('403 without a readable problem body is still a denial', async () => {
    const { client } = clientAnswering(new Response('<html>', { status: 403 }))
    expect(await client.getMe()).toEqual({ status: 'forbidden', problem: null })
  })

  it.each([
    ['an undocumented status', jsonResponse(502, {})],
    ['a 200 body outside the contract', jsonResponse(200, { ...readerMe, roles: ['owner'] })],
    ['a 200 body that is not JSON', new Response('not json', { status: 200 })],
    ['a network failure', new TypeError('Failed to fetch')],
  ])('%s is reported as unavailable', async (_name, response) => {
    const { client } = clientAnswering(response)
    expect(await client.getMe()).toEqual({ status: 'unavailable' })
  })
})

describe('IF-5 sign out', () => {
  it('POSTs /auth/logout with the session cookie', async () => {
    const { fetchImpl, client } = clientAnswering(new Response(null, { status: 204 }))
    await client.signOut()
    expect(fetchImpl).toHaveBeenCalledWith('/auth/logout', { method: 'POST', credentials: 'same-origin' })
  })

  it('resolves even when the BFF cannot be reached', async () => {
    const { client } = clientAnswering(new TypeError('Failed to fetch'))
    await expect(client.signOut()).resolves.toBeUndefined()
  })
})

describe('IF-1 GET /auth/login', () => {
  const returnTo = if1.parameterSchema('/auth/login', 'get', 'returnTo')
  const maxAge = if1.parameterSchema('/auth/login', 'get', 'maxAge')

  it('builds the bare sign-in address', () => {
    expect(loginUrl()).toBe('/auth/login')
  })

  it('returns to the signing-in frame, with a same-origin returnTo the contract accepts', () => {
    const url = new URL(loginUrl({ returnTo: '/signing-in' }), 'https://reports.contoso.com')
    expect(url.pathname).toBe('/auth/login')
    expect(url.searchParams.get('returnTo')).toBe('/signing-in')
    expect(validate(url.searchParams.get('returnTo'), returnTo)).toEqual([])
  })

  it('forces a fresh Microsoft sign-in with maxAge=0 for a different account', () => {
    const url = new URL(loginUrl({ returnTo: '/signing-in', maxAge: 0 }), 'https://reports.contoso.com')
    expect(url.searchParams.get('maxAge')).toBe('0')
    expect(validate(Number(url.searchParams.get('maxAge')), maxAge)).toEqual([])
  })
})

describe('response guards', () => {
  it('accept contract-shaped values and refuse the rest', () => {
    expect(isMe(readerMe)).toBe(true)
    expect(isMe(null)).toBe(false)
    expect(isMe({ ...readerMe, roles: 'reader' })).toBe(false)
    expect(isProblem(noAccessProblem)).toBe(true)
    expect(isProblem({ ...noAccessProblem, status: '403' })).toBe(false)
    expect(
      validate(readerMe, loadContract('IF-4').responseSchema('/api/v1/me', 'get', 200, 'application/json')),
    ).toEqual([])
  })
})
