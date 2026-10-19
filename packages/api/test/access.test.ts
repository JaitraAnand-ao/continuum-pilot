import { describe, expect, it, vi } from 'vitest'
import { sha256Hex } from '../src/crypto.js'
import { buildApp } from '../src/app.js'
import { OidcUnavailableError } from '../src/oidc.js'
import { expectHonours, loadContract } from './support/contract.js'
import { harness, setCookies, signIn } from './support/harness.js'

/* Building the first Fastify instance of a run is slow on a cold CI worker. */
vi.setConfig({ testTimeout: 30_000 })

const IF4 = loadContract('IF-4')
const MINUTE = 60_000

function get(h: ReturnType<typeof harness>, url: string, session?: string) {
  return h.app.inject({
    method: 'GET',
    url,
    headers: session === undefined ? {} : { cookie: `__Host-sr_session=${session}` },
  })
}

describe('IF-4 GET /api/v1/me', () => {
  it('AC-2: names a reader and their roles, with the session limits, never cached', async () => {
    const h = harness({ roles: ['reader'] })
    const session = await signIn(h)
    h.clock.advance(MINUTE)
    const response = await get(h, '/api/v1/me', session)
    expect(response.statusCode).toBe(200)
    expectHonours(IF4, '/api/v1/me', 'get', response)
    expect(response.json()).toEqual({
      account: 'm.duarte@contoso.com',
      displayName: 'M. Duarte',
      roles: ['reader'],
      authTime: '2026-10-19T08:00:00.000Z',
      idleExpiresAt: '2026-10-19T08:16:00.000Z',
      absoluteExpiresAt: '2026-10-19T16:00:00.000Z',
    })
  })

  it('AC-3: names both roles for a reader who is also a report administrator', async () => {
    const h = harness({ roles: ['config.read', 'reader', 'config.write'] })
    const response = await get(h, '/api/v1/me', await signIn(h))
    expectHonours(IF4, '/api/v1/me', 'get', response)
    expect(response.json().roles).toEqual(['reader', 'config.read', 'config.write'])
  })

  it('AC-5: answers 403 no-access naming the account, with no data, and records an access-denied audit event', async () => {
    const h = harness({ roles: [] })
    const session = await signIn(h)
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: {
        cookie: `__Host-sr_session=${session}`,
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      },
    })
    expect(response.statusCode).toBe(403)
    expectHonours(IF4, '/api/v1/me', 'get', response)
    expect(response.json()).toEqual({
      type: '/problems/no-access',
      title: "You don't have access. Signed in as m.duarte@contoso.com.",
      status: 403,
      traceId: '0af7651916cd43dd8448eb211c80319c',
    })
    expect(h.audit.events.at(-1)).toEqual({
      type: 'access.denied',
      at: h.clock.now(),
      traceId: '0af7651916cd43dd8448eb211c80319c',
      subject: 'sub-1',
      account: 'm.duarte@contoso.com',
      route: '/api/v1/me',
      reason: 'neither reader nor administrator',
    })
  })

  it('AC-7: answers 401 problem+json without a session, or with an unknown one', async () => {
    const h = harness()
    for (const session of [undefined, 'not-a-session']) {
      const response = await get(h, '/api/v1/me', session)
      expect(response.statusCode).toBe(401)
      expectHonours(IF4, '/api/v1/me', 'get', response)
      expect(Object.keys(response.json()).sort()).toEqual(['status', 'title', 'traceId', 'type'])
    }
  })
})

describe('AC-7 report endpoints', () => {
  it('answer 401 with no session', async () => {
    const h = harness()
    const response = await get(h, '/api/v1/reports/daily/2026-10-18')
    expect(response.statusCode).toBe(401)
    expect(response.headers['content-type']).toContain('application/problem+json')
    expect(response.json()).toMatchObject({ type: '/problems/unauthenticated', status: 401 })
  })

  it('answer 403 problem+json with only type, title, status and traceId to an administrator without the reader role', async () => {
    const h = harness({ roles: ['config.read', 'config.write'] })
    const response = await get(h, '/api/v1/reports/daily/2026-10-18', await signIn(h))
    expect(response.statusCode).toBe(403)
    expect(response.headers['content-type']).toContain('application/problem+json')
    const body = response.json()
    expect(Object.keys(body).sort()).toEqual(['status', 'title', 'traceId', 'type'])
    expect(body).toMatchObject({ type: '/problems/forbidden', title: 'Forbidden', status: 403 })
    expect(body.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(h.audit.events.at(-1)).toMatchObject({ type: 'access.denied', route: '/api/v1/reports/daily/:date' })
  })

  it('AC-5: answer 403 with no report figures to an account in neither group, and audit the denial', async () => {
    const h = harness({ roles: [] })
    const response = await get(h, '/api/v1/reports/daily/2026-10-18', await signIn(h))
    expect(response.statusCode).toBe(403)
    expect(response.body).not.toContain('signIns')
    expect(h.audit.events.filter((e) => e.type === 'access.denied')).toHaveLength(1)
  })

  it('serve a reader', async () => {
    const h = harness({ roles: ['reader'] })
    const response = await get(h, '/api/v1/reports/daily/2026-10-18', await signIn(h))
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ date: '2026-10-18', signIns: 42 })
  })

  it('are not mounted when no report routes are registered', async () => {
    const h = harness()
    const app = buildApp({
      publicOrigin: 'https://r.test',
      sealingKey: h.sealingKey,
      oidc: h.oidc,
      sessions: h.sessions,
      audit: h.audit,
      clock: h.clock,
    })
    expect((await app.inject({ method: 'GET', url: '/api/v1/reports/daily/2026-10-18' })).statusCode).toBe(404)
  })
})

describe('AC-9 session limits', () => {
  it('keeps a session alive while it is used, sliding the idle limit', async () => {
    const h = harness()
    const session = await signIn(h)
    h.clock.advance(15 * MINUTE - 1)
    expect((await get(h, '/api/v1/me', session)).statusCode).toBe(200)
    h.clock.advance(15 * MINUTE - 1)
    const response = await get(h, '/api/v1/me', session)
    expect(response.json().idleExpiresAt).toBe('2026-10-19T08:44:59.998Z')
  })

  it('ends a session after 15 minutes idle and clears its cookie', async () => {
    const h = harness()
    const session = await signIn(h)
    h.clock.advance(15 * MINUTE)
    const response = await get(h, '/api/v1/reports/daily/2026-10-18', session)
    expect(response.statusCode).toBe(401)
    expect(setCookies(response.headers)).toEqual([
      '__Host-sr_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict',
    ])
    expect(h.sessions.rows.has(sha256Hex(session))).toBe(false)
  })

  it('ends a session after 8 hours even when it is used every few minutes, and its cookie stays dead', async () => {
    const h = harness()
    const session = await signIn(h)
    for (let at = 0; at < 8 * 60 - 5; at += 5) {
      h.clock.advance(5 * MINUTE)
      expect((await get(h, '/api/v1/reports/daily/2026-10-18', session)).statusCode).toBe(200)
    }
    h.clock.advance(5 * MINUTE + MINUTE) /* 16:01 UTC */
    expect(h.clock.now().toISOString()).toBe('2026-10-19T16:01:00.000Z')
    expect((await get(h, '/api/v1/reports/daily/2026-10-18', session)).statusCode).toBe(401)
    h.clock.advance(-2 * MINUTE)
    expect((await get(h, '/api/v1/me', session)).statusCode).toBe(401)
  })
})

describe('AC-9 POST /auth/logout', () => {
  it('ends the session here and at Keycloak, clears the cookie, and the old cookie is answered 401', async () => {
    const h = harness()
    const session = await signIn(h)
    const response = await h.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: `__Host-sr_session=${session}` },
    })
    expect(response.statusCode).toBe(204)
    expect(setCookies(response.headers)).toEqual([
      '__Host-sr_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict',
    ])
    expect(h.oidc.endedSessions).toEqual(['refresh-token-value'])
    expect(h.sessions.rows.size).toBe(0)
    expect(h.audit.events.at(-1)).toMatchObject({ type: 'session.signed_out', account: 'm.duarte@contoso.com' })
    expect((await get(h, '/api/v1/me', session)).statusCode).toBe(401)
  })

  it('still ends the local session when Keycloak logout fails', async () => {
    const h = harness()
    h.oidc.failEndSession = new OidcUnavailableError('Keycloak logout failed')
    const session = await signIn(h)
    const response = await h.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: `__Host-sr_session=${session}` },
    })
    expect(response.statusCode).toBe(204)
    expect((await get(h, '/api/v1/me', session)).statusCode).toBe(401)
  })

  it('skips Keycloak when no refresh token was issued, and is harmless without a session', async () => {
    const h = harness()
    h.oidc.refreshToken = null
    const session = await signIn(h)
    await h.app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: `__Host-sr_session=${session}` } })
    expect(h.oidc.endedSessions).toEqual([])
    const anonymous = await h.app.inject({ method: 'POST', url: '/auth/logout' })
    expect(anonymous.statusCode).toBe(204)
    expect(h.audit.events.filter((e) => e.type === 'session.signed_out')).toHaveLength(1)
  })
})
