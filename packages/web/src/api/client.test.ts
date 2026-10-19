import { describe, expect, it } from 'vitest'
import { createApiClient, loginHref } from './client'
import if1 from './if-1.contract.json'
import if4 from './if-4.contract.json'
import { contractErrors } from '../test-support/schema'
import {
  adminOnlyMe,
  fakeFetch,
  json,
  noAccessProblem,
  noSessionProblem,
  problem,
  readerAdminMe,
  readerMe,
} from '../test-support/fixtures'

describe('the fixtures are responses the IF-4 contract allows', () => {
  it.each([
    ['reader', readerMe],
    ['reader and administrator', readerAdminMe],
    ['administrator only', adminOnlyMe],
  ])('200 for a %s', (_name, body) => {
    expect(contractErrors(if4, 'get', '/api/v1/me', 200, 'application/json', body)).toEqual([])
  })

  it('401 without a session', () => {
    expect(contractErrors(if4, 'get', '/api/v1/me', 401, 'application/problem+json', noSessionProblem)).toEqual([])
  })

  it('403 for an account in neither group', () => {
    expect(contractErrors(if4, 'get', '/api/v1/me', 403, 'application/problem+json', noAccessProblem)).toEqual([])
  })

  it('the checker itself rejects what the contract does not allow', () => {
    const bad = { ...readerMe, roles: ['reader', 'reader', 'owner'], token: 'x', authTime: 'yesterday' }
    expect(contractErrors(if4, 'get', '/api/v1/me', 200, 'application/json', bad)).toEqual([
      '$.roles: items are not unique',
      '$.roles[2]: "owner" is not in the enum',
      '$.authTime: not a date-time',
      '$: unexpected property token',
    ])
    expect(contractErrors(if4, 'get', '/api/v1/me', 403, 'application/problem+json', { status: '403' })).toEqual([
      '$: missing type',
      '$: missing title',
      '$: missing traceId',
      '$.status: expected integer, got string',
    ])
    expect(
      contractErrors(if4, 'get', '/api/v1/me', 403, 'application/problem+json', { ...noAccessProblem, status: 401 }),
    ).toEqual(['$.status: expected 403'])
    expect(
      contractErrors(if4, 'get', '/api/v1/me', 403, 'application/problem+json', { ...noAccessProblem, title: 'No' }),
    ).toEqual(['$.title: does not match pattern'])
    expect(contractErrors(if4, 'get', '/api/v1/me', 500, 'application/json', {})).toEqual([
      'GET /api/v1/me documents no 500 response',
    ])
    expect(contractErrors(if1, 'get', '/auth/login', 302, 'application/json', {})).toEqual([
      'GET /auth/login 302 documents no application/json body',
    ])
    expect(() =>
      contractErrors(
        {
          paths: {
            '/x': {
              get: { responses: { 200: { content: { 'a/b': { schema: { $ref: '#/components/schemas/Nope' } } } } } },
            },
          },
        },
        'get',
        '/x',
        200,
        'a/b',
        {},
      ),
    ).toThrow('unresolved #/components/schemas/Nope')
  })
})

describe('loginHref builds the IF-1 start-sign-in address', () => {
  const pattern = new RegExp(
    (if1.paths['/auth/login'].get.parameters[0] as { schema: { pattern: string } }).schema.pattern,
  )

  it('returns to the requested same-origin path', () => {
    expect(loginHref({ returnTo: '/reports/daily' })).toBe('/auth/login?returnTo=%2Freports%2Fdaily')
    expect(pattern.test('/reports/daily')).toBe(true)
  })

  it('forces a fresh Microsoft sign-in with maxAge=0', () => {
    expect(loginHref({ returnTo: '/reports/daily', maxAge: 0 })).toBe(
      '/auth/login?returnTo=%2Freports%2Fdaily&maxAge=0',
    )
  })

  it('drops a returnTo the contract would refuse rather than send it', () => {
    expect(loginHref({ returnTo: '//evil.example/x' })).toBe('/auth/login')
    expect(loginHref({ returnTo: 'https://evil.example/' })).toBe('/auth/login')
    expect(loginHref({})).toBe('/auth/login')
  })
})

describe('getMe reads IF-4 into one result per documented status', () => {
  it('200 is a signed-in account carrying exactly the server payload', async () => {
    const { fetch, calls } = fakeFetch(json(200, readerAdminMe))
    const result = await createApiClient(fetch).getMe()
    expect(result).toEqual({ kind: 'signed-in', me: readerAdminMe })
    expect(calls).toEqual([
      {
        url: '/api/v1/me',
        init: { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' }, cache: 'no-store' },
      },
    ])
  })

  it('401 is signed out', async () => {
    const { fetch } = fakeFetch(problem(noSessionProblem))
    expect(await createApiClient(fetch).getMe()).toEqual({ kind: 'signed-out' })
  })

  it('403 no-access carries the server title naming the account', async () => {
    const { fetch } = fakeFetch(problem(noAccessProblem))
    expect(await createApiClient(fetch).getMe()).toEqual({
      kind: 'no-access',
      title: "You don't have access. Signed in as p.ruiz@fabrikam.com.",
    })
  })

  it('a 403 that is not the no-access problem is treated as unavailable, never as access', async () => {
    const { fetch } = fakeFetch(problem({ ...noAccessProblem, type: '/problems/forbidden' }))
    expect(await createApiClient(fetch).getMe()).toEqual({ kind: 'unavailable', traceId: noAccessProblem.traceId })
  })

  it('an undocumented status is unavailable, keeping the trace id when the body is a problem', async () => {
    const { fetch } = fakeFetch(problem({ ...noSessionProblem, status: 503 }), new Response('oops', { status: 502 }))
    const client = createApiClient(fetch)
    expect(await client.getMe()).toEqual({ kind: 'unavailable', traceId: noSessionProblem.traceId })
    expect(await client.getMe()).toEqual({ kind: 'unavailable' })
  })

  it('a network failure is unavailable', async () => {
    const { fetch } = fakeFetch(new TypeError('Failed to fetch'))
    expect(await createApiClient(fetch).getMe()).toEqual({ kind: 'unavailable' })
  })

  it.each([
    ['a role outside the contract', { ...readerMe, roles: ['owner'] }],
    ['a missing field', { ...readerMe, account: undefined }],
    ['an unparseable limit', { ...readerMe, idleExpiresAt: 'soon' }],
    ['roles that are not a list', { ...readerMe, roles: 'reader' }],
    ['a body that is not an object', ['reader']],
  ])('a 200 with %s is unavailable, never trusted', async (_name, body) => {
    const { fetch } = fakeFetch(json(200, body))
    expect(await createApiClient(fetch).getMe()).toEqual({ kind: 'unavailable' })
  })
})

describe('signOut ends the server session', () => {
  it('posts to /auth/logout with the session cookie only', async () => {
    const { fetch, calls } = fakeFetch(new Response(null, { status: 204 }))
    await createApiClient(fetch).signOut()
    expect(calls).toEqual([{ url: '/auth/logout', init: { method: 'POST', credentials: 'same-origin' } }])
  })

  it('resolves even when the network fails, so the browser still leaves the session', async () => {
    const { fetch } = fakeFetch(new TypeError('Failed to fetch'))
    await expect(createApiClient(fetch).signOut()).resolves.toBeUndefined()
  })
})
