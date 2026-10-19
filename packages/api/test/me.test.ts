/* IF-4 GET /api/v1/me (ST-1 AC-2, AC-3, AC-5, AC-7): the signed-in account, its roles and session limits;
 * an account in neither group is answered 403 /problems/no-access naming its UPN, and the denial is audited. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadContract, responseSchema, violations } from './support/contract.js'
import { ADMIN_ONLY, OUTSIDER, READER, READER_ADMIN, signIn, startHarness, type Harness } from './support/harness.js'

const IF4 = loadContract('IF-4')
const ok = responseSchema(IF4, '/api/v1/me', 'get', 200, 'application/json')
const unauthenticated = responseSchema(IF4, '/api/v1/me', 'get', 401, 'application/problem+json')
const noAccess = responseSchema(IF4, '/api/v1/me', 'get', 403, 'application/problem+json')
let harness: Harness

beforeEach(async () => {
  harness = await startHarness()
})
afterEach(async () => {
  await harness.close()
})

const me = (cookie?: string) => harness.app.inject({ url: '/api/v1/me', ...(cookie ? { headers: { cookie } } : {}) })

describe('GET /api/v1/me', () => {
  it('describes a reader: account, name, roles, auth time and both session limits (AC-2)', async () => {
    const { sessionCookie } = await signIn(harness, { ...READER, auth_time: Date.parse('2026-10-19T07:59:30Z') / 1000 })
    const response = await me(sessionCookie)
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    const body = response.json()
    expect(body).toEqual({
      account: 'm.duarte@contoso.com',
      displayName: 'Marta Duarte',
      roles: ['reader'],
      authTime: '2026-10-19T07:59:30.000Z',
      idleExpiresAt: '2026-10-19T08:15:00.000Z',
      absoluteExpiresAt: '2026-10-19T16:00:00.000Z',
    })
    expect(await violations(ok, body)).toEqual([])
  })

  it('names both roles for an account holding the reader and administrator claims (AC-3)', async () => {
    const { sessionCookie } = await signIn(harness, READER_ADMIN)
    const body = (await me(sessionCookie)).json()
    expect(body.roles).toEqual(['reader', 'config.read', 'config.write'])
    expect(await violations(ok, body)).toEqual([])
  })

  it('describes an administrator without the reader role, so the SPA can show only what it may', async () => {
    const { sessionCookie } = await signIn(harness, ADMIN_ONLY)
    const response = await me(sessionCookie)
    expect(response.statusCode).toBe(200)
    expect(response.json().roles).toEqual(['config.read'])
  })

  it('uses the token’s iat as the auth time when Keycloak sends no auth_time', async () => {
    const { sessionCookie } = await signIn(harness, READER)
    expect((await me(sessionCookie)).json().authTime).toBe('2026-10-19T08:00:00.000Z')
  })

  it('answers 401 problem+json with no session, or with an unknown session cookie (AC-7)', async () => {
    for (const cookie of [undefined, '__Host-sr_session=not-a-session', 'other=1']) {
      const response = await me(cookie)
      expect(response.statusCode).toBe(401)
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/)
      const body = response.json()
      expect(Object.keys(body).sort()).toEqual(['status', 'title', 'traceId', 'type'])
      expect(body.type).toBe('/problems/unauthenticated')
      expect(await violations(unauthenticated, body)).toEqual([])
    }
    expect(harness.audit.events).toEqual([])
  })

  it('answers 403 /problems/no-access naming the UPN, returns nothing else and audits the denial (AC-5)', async () => {
    const { sessionCookie } = await signIn(harness, OUTSIDER)
    const response = await me(sessionCookie)
    expect(response.statusCode).toBe(403)
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/)
    const body = response.json()
    expect(body).toEqual({
      type: '/problems/no-access',
      title: "You don't have access. Signed in as k.brown@contoso.com.",
      status: 403,
      traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
    })
    expect(await violations(noAccess, body)).toEqual([])
    expect(harness.audit.events).toEqual([
      {
        type: 'access-denied',
        account: 'k.brown@contoso.com',
        route: '/api/v1/me',
        traceId: body.traceId,
        at: harness.clock.now(),
      },
    ])
  })

  it('does not extend the idle limit: reading the account is not activity', async () => {
    const { sessionCookie } = await signIn(harness, READER)
    harness.clock.advance(10 * 60 * 1000)
    expect((await me(sessionCookie)).json().idleExpiresAt).toBe('2026-10-19T08:15:00.000Z')
  })
})
