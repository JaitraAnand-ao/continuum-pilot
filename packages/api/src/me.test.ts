import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IDLE_LIMIT_MS } from './session/policy.js'
import { assertHonoursContract } from './test-support/contract.js'
import {
  ADMIN_ONLY,
  createHarness,
  OUTSIDER,
  READER,
  READER_AND_ADMIN,
  SIGNED_IN_AT,
  type Harness,
} from './test-support/harness.js'

let h: Harness
beforeEach(async () => {
  h = await createHarness()
})
afterEach(async () => {
  await h.close()
})

const me = (cookie?: string) =>
  h.app.inject({
    method: 'GET',
    url: '/api/v1/me',
    headers: cookie === undefined ? {} : { cookie: `__Host-sr_session=${cookie}` },
  })

const minutes = (n: number): number => n * 60 * 1000

describe('IF-4 GET /api/v1/me', () => {
  it('AC-2: tells a reader who they are, their roles and the session limits', async () => {
    const response = await me(await h.signIn(READER))
    expect(response.statusCode).toBe(200)
    assertHonoursContract('IF-4', '/api/v1/me', response)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toEqual({
      account: READER.upn,
      displayName: READER.name,
      roles: ['reader'],
      authTime: SIGNED_IN_AT.toISOString(),
      idleExpiresAt: '2026-10-19T08:15:00.000Z',
      absoluteExpiresAt: '2026-10-19T16:00:00.000Z',
    })
  })

  it('AC-3: names both the reader and the administrator roles', async () => {
    const response = await me(await h.signIn(READER_AND_ADMIN))
    assertHonoursContract('IF-4', '/api/v1/me', response)
    expect(response.json().roles).toEqual(['reader', 'config.read', 'config.write', 'config.approve'])
  })

  it('lets an administrator without the reader role see their account', async () => {
    const response = await me(await h.signIn(ADMIN_ONLY))
    expect(response.statusCode).toBe(200)
    expect(response.json().roles).toEqual(['config.read', 'config.write'])
  })

  it('AC-7: answers 401 problem+json without a session or with an unknown cookie', async () => {
    for (const response of [await me(), await me('not-a-session')]) {
      expect(response.statusCode).toBe(401)
      assertHonoursContract('IF-4', '/api/v1/me', response)
      expect(Object.keys(response.json()).sort()).toEqual(['status', 'title', 'traceId', 'type'])
      expect(response.json()).toMatchObject({ type: '/problems/unauthenticated', status: 401 })
    }
  })

  it('AC-5: answers 403 no-access naming the signed-in account and records an access-denied event', async () => {
    const cookie = await h.signIn(OUTSIDER)
    h.audit.events.length = 0
    const response = await me(cookie)
    expect(response.statusCode).toBe(403)
    assertHonoursContract('IF-4', '/api/v1/me', response)
    expect(response.json()).toEqual({
      type: '/problems/no-access',
      title: `You don't have access. Signed in as ${OUTSIDER.upn}.`,
      status: 403,
      traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
    })
    expect(h.audit.events).toEqual([
      expect.objectContaining({ type: 'access-denied', account: OUTSIDER.upn, route: '/api/v1/me', method: 'GET' }),
    ])
  })

  it('AC-9: activity moves the idle limit forward', async () => {
    const cookie = await h.signIn(READER)
    h.clock.advance(minutes(10))
    expect((await me(cookie)).json().idleExpiresAt).toBe('2026-10-19T08:25:00.000Z')
    expect(h.sessions.rows()[0]?.lastSeenAt).toEqual(new Date('2026-10-19T08:10:00.000Z'))
  })

  it('AC-9: a session idle one millisecond under 15 minutes survives; at 15 minutes it is ended', async () => {
    const cookie = await h.signIn(READER)
    h.clock.advance(IDLE_LIMIT_MS - 1)
    expect((await me(cookie)).statusCode).toBe(200)
    h.clock.advance(IDLE_LIMIT_MS)
    expect((await me(cookie)).statusCode).toBe(401)
    expect(h.sessions.rows()).toHaveLength(0)
  })

  it('AC-9: a reader active every few minutes since 08:00 is signed out at 16:00 and the cookie stays dead', async () => {
    const cookie = await h.signIn(READER)
    while (h.clock.now().getTime() + minutes(7) < Date.parse('2026-10-19T16:00:00.000Z')) {
      h.clock.advance(minutes(7))
      expect((await me(cookie)).statusCode).toBe(200)
    }
    h.clock.set(new Date('2026-10-19T16:01:00.000Z'))
    expect((await me(cookie)).statusCode).toBe(401)
    h.clock.set(new Date('2026-10-19T16:02:00.000Z'))
    expect((await me(cookie)).statusCode).toBe(401)
  })
})
