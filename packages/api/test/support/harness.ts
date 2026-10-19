import { randomBytes } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import { buildApp } from '../../src/app.js'
import { InMemoryAuditLog } from '../../src/audit.js'
import type { Identity } from '../../src/oidc.js'
import { InMemorySessionStore } from '../../src/session-store.js'
import { FixedClock } from './clock.js'
import { FakeOidc, identity } from './fake-oidc.js'

export const ORIGIN = 'https://reports.contoso.test'

/* A report route standing in for the ones later stories add behind the reader guard. */
export const dailyReport: FastifyPluginAsync = async (scope) => {
  scope.get('/daily/:date', async () => ({ date: '2026-10-18', signIns: 42 }))
}

export function harness(who: Partial<Identity> = {}) {
  const clock = new FixedClock('2026-10-19T08:00:00.000Z')
  const oidc = new FakeOidc(identity(who))
  const sessions = new InMemorySessionStore()
  const audit = new InMemoryAuditLog()
  const sealingKey = randomBytes(32)
  const app = buildApp({ publicOrigin: ORIGIN, sealingKey, oidc, sessions, audit, clock, reportRoutes: dailyReport })
  return { app, clock, oidc, sessions, audit, sealingKey }
}

export function setCookies(headers: Record<string, unknown>): string[] {
  const value = headers['set-cookie']
  if (value === undefined) return []
  return Array.isArray(value) ? (value as string[]) : [String(value)]
}

export function cookieValue(setCookie: string[], name: string): string | undefined {
  const line = setCookie.find((cookie) => cookie.startsWith(`${name}=`))
  return line?.slice(name.length + 1).split(';')[0]
}

/* Walks /auth/login then /auth/callback the way the browser does, returning the session cookie value. */
export async function signIn(h: ReturnType<typeof harness>): Promise<string> {
  const login = await h.app.inject({ method: 'GET', url: '/auth/login' })
  const loginCookie = cookieValue(setCookies(login.headers), '__Host-sr_login')
  const state = new URL(String(login.headers.location)).searchParams.get('state')
  const callback = await h.app.inject({
    method: 'GET',
    url: `/auth/callback?code=the-code&state=${state}`,
    headers: { cookie: `__Host-sr_login=${loginCookie}` },
  })
  const session = cookieValue(setCookies(callback.headers), '__Host-sr_session')
  if (!session) throw new Error(`sign-in did not issue a session: ${callback.statusCode}`)
  return session
}
