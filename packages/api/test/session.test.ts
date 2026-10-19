/* ST-1 AC-9 through the routes, with the injected Clock: the idle warning lead, 'Stay signed in', the 15-minute
 * idle end, the 8-hour absolute end, and sign-out ending the local and the Keycloak session. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sha256Hex } from '../src/crypto.js'
import { declaresNoContent, headerSchema, loadContract, responseSchema, violations } from './support/contract.js'
import { OUTSIDER, READER, setCookies, signIn, startHarness, type Harness } from './support/harness.js'
import { reportGateRoute } from './support/report-gate.js'

const IF3 = loadContract('IF-3')
const IF5 = loadContract('IF-5')
const ok = responseSchema(IF5, '/api/v1/session/keepalive', 'post', 200, 'application/json')
const noAccess = responseSchema(IF5, '/api/v1/session/keepalive', 'post', 403, 'application/problem+json')
const logoutUnauthenticated = responseSchema(IF3, '/auth/logout', 'post', 401, 'application/problem+json')
const gateUnauthenticated = responseSchema(
  loadContract('IF-6'),
  '/api/v1/reports/daily/{date}',
  'get',
  401,
  'application/problem+json',
)
const MINUTE = 60_000
let harness: Harness

beforeEach(async () => {
  harness = await startHarness({ routes: reportGateRoute() })
})
afterEach(async () => {
  await harness.close()
})

const keepAlive = (cookie: string) =>
  harness.app.inject({ method: 'POST', url: '/api/v1/session/keepalive', headers: { cookie } })
const report = (cookie: string) => harness.app.inject({ url: '/api/v1/reports/daily/2026-10-18', headers: { cookie } })
const me = (cookie: string) => harness.app.inject({ url: '/api/v1/me', headers: { cookie } })

async function useEveryTenMinutesUntil(cookie: string, until: string) {
  while (harness.clock.now().getTime() < Date.parse(until)) {
    harness.clock.advance(10 * MINUTE)
    expect((await report(cookie)).statusCode).toBe(200)
  }
}

describe('idle limit', () => {
  it('reports an idle limit that leaves the 2-minute warning at 13 minutes idle', async () => {
    const { sessionCookie } = await signIn(harness, READER)
    const { idleExpiresAt } = (await me(sessionCookie)).json()
    expect(Date.parse(idleExpiresAt) - 2 * MINUTE).toBe(Date.parse('2026-10-19T08:13:00.000Z'))
  })

  it("'Stay signed in' at 13 minutes idle restarts the 15 minutes", async () => {
    const { sessionCookie } = await signIn(harness, READER)
    harness.clock.advance(13 * MINUTE)
    const response = await keepAlive(sessionCookie)
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    const body = response.json()
    expect(body.idleExpiresAt).toBe('2026-10-19T08:28:00.000Z')
    expect(await violations(ok, body)).toEqual([])
    harness.clock.advance(15 * MINUTE - 1)
    expect((await me(sessionCookie)).statusCode).toBe(200)
  })

  it('keeps the session one millisecond before 15 minutes idle and ends it at 15 minutes', async () => {
    const { sessionCookie, session } = await signIn(harness, READER)
    harness.clock.advance(15 * MINUTE - 1)
    expect((await me(sessionCookie)).statusCode).toBe(200)
    harness.clock.advance(1)
    const expired = await report(sessionCookie)
    expect(expired.statusCode).toBe(401)
    expect(expired.json().type).toBe('/problems/unauthenticated')
    expect(await violations(gateUnauthenticated, expired.json())).toEqual([])
    expect(setCookies(expired.headers)).toEqual([
      '__Host-sr_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
    ])
    expect(harness.sessions.rows.has(sha256Hex(session ?? ''))).toBe(false)
  })

  it('counts a report request as activity', async () => {
    const { sessionCookie } = await signIn(harness, READER)
    harness.clock.advance(14 * MINUTE)
    expect((await report(sessionCookie)).statusCode).toBe(200)
    harness.clock.advance(14 * MINUTE)
    expect((await me(sessionCookie)).statusCode).toBe(200)
  })

  it('refuses keep-alive to an account in neither group, auditing it', async () => {
    const { sessionCookie } = await signIn(harness, OUTSIDER)
    const response = await keepAlive(sessionCookie)
    expect(response.statusCode).toBe(403)
    expect(response.json().type).toBe('/problems/no-access')
    expect(await violations(noAccess, response.json())).toEqual([])
    expect(harness.audit.events.map((event) => event.type)).toEqual(['access-denied'])
  })
})

describe('absolute limit', () => {
  it('ends a session at 8 hours even when it is used every few minutes, and the old cookie stays 401', async () => {
    const { sessionCookie } = await signIn(harness, READER)
    await useEveryTenMinutesUntil(sessionCookie, '2026-10-19T15:50:00.000Z')
    harness.clock.set('2026-10-19T15:59:59.999Z')
    expect((await report(sessionCookie)).statusCode).toBe(200)
    harness.clock.set('2026-10-19T16:01:00.000Z')
    expect((await report(sessionCookie)).statusCode).toBe(401)
    expect((await me(sessionCookie)).statusCode).toBe(401)
  })

  it("does not let 'Stay signed in' extend past 8 hours", async () => {
    const { sessionCookie } = await signIn(harness, READER)
    await useEveryTenMinutesUntil(sessionCookie, '2026-10-19T15:50:00.000Z')
    harness.clock.advance(5 * MINUTE)
    expect((await keepAlive(sessionCookie)).json().idleExpiresAt).toBe('2026-10-19T16:00:00.000Z')
  })
})

describe('POST /auth/logout', () => {
  it('ends the session, clears the cookie and ends the Keycloak session; the old cookie is then 401', async () => {
    const { sessionCookie, session } = await signIn(harness, READER)
    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: sessionCookie },
    })
    expect(response.statusCode).toBe(204)
    expect(response.body).toBe('')
    expect(setCookies(response.headers)).toEqual([
      '__Host-sr_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
    ])
    expect(declaresNoContent(IF3, '/auth/logout', 'post', 204)).toBe(true)
    const cleared = headerSchema(IF3, '/auth/logout', 'post', 204, 'Set-Cookie')
    expect(await violations(cleared, setCookies(response.headers)[0])).toEqual([])
    expect(harness.sessions.rows.has(sha256Hex(session ?? ''))).toBe(false)
    expect(harness.keycloak.endedRefreshTokens).toEqual(['refresh-token-1-secret-value'])
    expect((await me(sessionCookie)).statusCode).toBe(401)
    expect((await report(sessionCookie)).statusCode).toBe(401)
  })

  it('still ends the local session when Keycloak refuses the logout', async () => {
    harness.keycloak.logoutStatus = 500
    const { sessionCookie } = await signIn(harness, READER)
    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: sessionCookie },
    })
    expect(response.statusCode).toBe(204)
    expect(harness.keycloak.logoutRequests).toHaveLength(1)
    expect((await me(sessionCookie)).statusCode).toBe(401)
  })

  it('answers 401 without a session', async () => {
    const response = await harness.app.inject({ method: 'POST', url: '/auth/logout' })
    expect(response.statusCode).toBe(401)
    expect(await violations(logoutUnauthenticated, response.json())).toEqual([])
    expect(harness.keycloak.logoutRequests).toEqual([])
  })
})
