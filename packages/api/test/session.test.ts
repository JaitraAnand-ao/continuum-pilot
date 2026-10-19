/* IF-4 GET /api/v1/me, IF-3 POST /auth/logout, the role gate on report routes and the AD-5 session limits
 * (ST-1 AC-2, AC-3, AC-5, AC-7, AC-9). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SESSION_COOKIE } from '../src/app.js'
import { ADMIN_ONLY, BOTH, OUTSIDER, READER } from './support/fake-keycloak.js'
import { createHarness, setCookies, signIn, withSession, type Harness } from './support/harness.js'

let h: Harness
beforeEach(() => {
  h = createHarness()
})
afterEach(async () => {
  await h.app.close()
})

const me = (session?: string) => h.app.inject({ method: 'GET', url: '/api/v1/me', cookies: withSession(session) })
const report = (session?: string) =>
  h.app.inject({ method: 'GET', url: '/api/v1/reports/daily/2026-10-18', cookies: withSession(session) })

function expectProblem(response: Awaited<ReturnType<typeof me>>, status: number, type: string) {
  expect(response.statusCode).toBe(status)
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/)
  const body = response.json()
  expect(Object.keys(body).sort()).toEqual(['status', 'title', 'traceId', 'type'])
  expect(body).toMatchObject({ type, status })
  expect(body.traceId).toMatch(/^[0-9a-f]{32}$/)
  return body
}

describe('GET /api/v1/me', () => {
  it('describes a reader: account, roles, auth time and both limits, never cached (AC-2)', async () => {
    const { session } = await signIn(h, READER)
    h.clock.advance(60_000)
    const response = await me(session)
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toEqual({
      account: READER.upn,
      displayName: READER.name,
      roles: ['reader'],
      authTime: '2026-10-19T08:00:00.000Z',
      idleExpiresAt: '2026-10-19T08:16:00.000Z',
      absoluteExpiresAt: '2026-10-19T16:00:00.000Z',
    })
  })

  it('names both roles for a reader who is also a report administrator (AC-3)', async () => {
    const { session } = await signIn(h, BOTH)
    expect((await me(session)).json().roles).toEqual(['reader', 'config.read', 'config.write', 'config.approve'])
  })

  it('answers 401 problem+json without a session or with an unknown cookie', async () => {
    expectProblem(await me(), 401, '/problems/unauthenticated')
    expectProblem(await me('not-a-session'), 401, '/problems/unauthenticated')
  })

  it('turns away an account in neither group with a 403 naming it, and audits the denial (AC-5)', async () => {
    const { session } = await signIn(h, OUTSIDER)
    h.audit.events.length = 0
    const body = expectProblem(await me(session), 403, '/problems/no-access')
    expect(body.title).toBe(`You don't have access. Signed in as ${OUTSIDER.upn}.`)
    expect(h.audit.events).toEqual([
      expect.objectContaining({ type: 'access-denied', account: OUTSIDER.upn, reason: 'no-role', route: '/api/v1/me' }),
    ])
    expect(h.audit.events[0]!.traceId).toBe(body.traceId)
  })
})

describe('report routes', () => {
  it('answer 401 with no session (AC-7)', async () => {
    const response = await report()
    expectProblem(response, 401, '/problems/unauthenticated')
    expect(response.body).not.toContain('totalSignIns')
  })

  it('answer 403 with only type, title, status and traceId to an administrator without the reader role, and audit it (AC-7)', async () => {
    const { session } = await signIn(h, ADMIN_ONLY)
    const response = await report(session)
    const body = expectProblem(response, 403, '/problems/forbidden')
    expect(body.title).toBe('Forbidden')
    expect(response.body).not.toContain('totalSignIns')
    expect(h.audit.events).toEqual([
      expect.objectContaining({
        type: 'access-denied',
        account: ADMIN_ONLY.upn,
        reason: 'missing-role',
        requiredRole: 'reader',
        route: '/api/v1/reports/daily/:date',
        traceId: body.traceId,
      }),
    ])
  })

  it('answer 403 and return no report figures to an account in neither group (AC-5)', async () => {
    const { session } = await signIn(h, OUTSIDER)
    const response = await report(session)
    expectProblem(response, 403, '/problems/forbidden')
    expect(response.body).not.toContain('totalSignIns')
  })

  it('serve a reader', async () => {
    const { session } = await signIn(h, READER)
    const response = await report(session)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ date: '2026-10-18', totalSignIns: 42 })
  })

  it('fail closed: an /api route that declares no requiredRole is refused even to a full administrator', async () => {
    h.app.get('/api/v1/undeclared', async () => ({ secret: true }))
    const { session } = await signIn(h, BOTH)
    const response = await h.app.inject({ url: '/api/v1/undeclared', cookies: withSession(session) })
    expectProblem(response, 403, '/problems/forbidden')
    expect(h.audit.events).toEqual([expect.objectContaining({ reason: 'route-undeclared' })])
  })
})

describe('idle limit (AC-9)', () => {
  it('keeps a session alive one millisecond before 15 minutes idle and ends it at 15 minutes', async () => {
    const { session } = await signIn(h, READER)
    h.clock.advance(15 * 60_000 - 1)
    expect((await me(session)).statusCode).toBe(200)
    h.clock.advance(15 * 60_000)
    expectProblem(await me(session), 401, '/problems/unauthenticated')
    expect(h.sessions.rows()).toHaveLength(0)
  })

  it('counts every authenticated request as activity', async () => {
    const { session } = await signIn(h, READER)
    h.clock.advance(10 * 60_000)
    expect((await report(session)).statusCode).toBe(200)
    h.clock.advance(10 * 60_000)
    expect((await me(session)).json().idleExpiresAt).toBe('2026-10-19T08:35:00.000Z')
  })
})

describe('absolute limit (AC-9)', () => {
  it('ends a session at 8 hours even when the reader stays active, and the old cookie is answered 401', async () => {
    const { session } = await signIn(h, READER)
    for (let minute = 10; minute < 8 * 60; minute += 10) {
      h.clock.set(new Date(Date.parse('2026-10-19T08:00:00.000Z') + minute * 60_000).toISOString())
      expect((await report(session)).statusCode).toBe(200)
    }
    h.clock.set('2026-10-19T15:59:59.999Z')
    expect((await me(session)).json().idleExpiresAt).toBe('2026-10-19T16:00:00.000Z')
    h.clock.set('2026-10-19T16:00:00.000Z')
    expectProblem(await report(session), 401, '/problems/unauthenticated')
    h.clock.set('2026-10-19T16:01:00.000Z')
    expectProblem(await report(session), 401, '/problems/unauthenticated')
  })
})

describe('POST /auth/logout (AC-9)', () => {
  it('ends the session here and at Keycloak, clears the cookie, and the old cookie is then answered 401', async () => {
    const { session } = await signIn(h, READER)
    const refreshToken = h.keycloak.state.issuedTokens[2]
    const response = await h.app.inject({ method: 'POST', url: '/auth/logout', cookies: withSession(session) })
    expect(response.statusCode).toBe(204)
    const cleared = setCookies(response).find((line) => line.startsWith(`${SESSION_COOKIE}=`))
    expect(cleared).toMatch(/Max-Age=0/)
    expect(cleared).toMatch(/; HttpOnly/)
    expect(cleared).toMatch(/; Secure/)
    expect(cleared).toMatch(/; SameSite=Strict/)
    expect(h.keycloak.state.endedRefreshTokens).toEqual([refreshToken])
    expect(h.sessions.rows()).toHaveLength(0)
    expectProblem(await me(session), 401, '/problems/unauthenticated')
  })

  it('still ends the local session when Keycloak cannot be reached', async () => {
    const { session } = await signIn(h, READER)
    h.keycloak.state.logoutDown = true
    const response = await h.app.inject({ method: 'POST', url: '/auth/logout', cookies: withSession(session) })
    expect(response.statusCode).toBe(204)
    expect(h.sessions.rows()).toHaveLength(0)
  })

  it('skips the Keycloak call when the session holds no refresh token', async () => {
    h.keycloak.state.omitRefreshToken = true
    const { session } = await signIn(h, READER)
    const response = await h.app.inject({ method: 'POST', url: '/auth/logout', cookies: withSession(session) })
    expect(response.statusCode).toBe(204)
    expect(h.keycloak.state.endedRefreshTokens).toEqual([])
  })

  it('is harmless without a session', async () => {
    const response = await h.app.inject({ method: 'POST', url: '/auth/logout' })
    expect(response.statusCode).toBe(204)
  })
})

describe('everything else', () => {
  it('answers unknown routes with a 404 problem', async () => {
    expectProblem(await h.app.inject({ url: '/nowhere' }), 404, '/problems/not-found')
  })

  it('answers an unexpected failure with a 500 problem that leaks nothing', async () => {
    h.app.get('/api/v1/broken', { config: { requiredRole: 'reader' } }, async () => {
      throw new Error('relation "secret_table" does not exist')
    })
    const { session } = await signIn(h, READER)
    const response = await h.app.inject({ url: '/api/v1/broken', cookies: withSession(session) })
    const body = expectProblem(response, 500, '/problems/internal')
    expect(response.body).not.toContain('secret_table')
    expect(body.title).toBe('Internal Server Error')
  })

  it('takes the trace ID from a valid W3C traceparent and makes one otherwise', async () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
    const traced = await h.app.inject({
      url: '/api/v1/me',
      headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
    })
    expect(traced.json().traceId).toBe(traceId)
    const untraced = await h.app.inject({ url: '/api/v1/me', headers: { traceparent: 'garbage' } })
    expect(untraced.json().traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(untraced.json().traceId).not.toBe(traceId)
    const zero = await h.app.inject({
      url: '/api/v1/me',
      headers: { traceparent: `00-${'0'.repeat(32)}-00f067aa0ba902b7-01` },
    })
    expect(zero.json().traceId).not.toBe('0'.repeat(32))
  })
})
