/* Builds the BFF wired to the fake Keycloak, an in-memory session store and audit log, and a clock the test moves. */
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { buildApp, LOGIN_COOKIE, SESSION_COOKIE } from '../../src/app.js'
import { InMemoryAuditLog } from '../../src/audit.js'
import type { Clock } from '../../src/clock.js'
import { loadConfig } from '../../src/config.js'
import { createOidcClient } from '../../src/auth/oidc.js'
import { InMemorySessionStore } from '../../src/session/store.js'
import { CLIENT_ID, CLIENT_SECRET, createFakeKeycloak, ISSUER, type FakeUser } from './fake-keycloak.js'

export const ORIGIN = 'https://reports.contoso.test'
export const TEST_ENV = {
  SR_PUBLIC_ORIGIN: ORIGIN,
  SR_OIDC_ISSUER: ISSUER,
  SR_OIDC_CLIENT_ID: CLIENT_ID,
  SR_OIDC_CLIENT_SECRET: CLIENT_SECRET,
  SR_SESSION_KEY: Buffer.alloc(32, 7).toString('base64'),
}

export class TestClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current.getTime())
  }
  set(iso: string): void {
    this.current = new Date(iso)
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms)
  }
}

export interface Harness {
  app: FastifyInstance
  clock: TestClock
  keycloak: ReturnType<typeof createFakeKeycloak>
  sessions: InMemorySessionStore
  audit: InMemoryAuditLog
}

export function createHarness(start = '2026-10-19T08:00:00.000Z'): Harness {
  const clock = new TestClock(new Date(start))
  const keycloak = createFakeKeycloak(() => clock.now())
  const config = loadConfig(TEST_ENV)
  const sessions = new InMemorySessionStore()
  const audit = new InMemoryAuditLog()
  const oidc = createOidcClient({
    issuer: config.oidc.issuer,
    clientId: config.oidc.clientId,
    clientSecret: config.oidc.clientSecret,
    redirectUri: `${config.publicOrigin}/auth/callback`,
    idpHint: config.oidc.idpHint,
    fetch: keycloak.fetch,
    clock,
  })
  const app = buildApp({ config, clock, sessions, audit, oidc })
  /* Stands in for a report route of a later story, declared the way every report route must be. */
  app.get('/api/v1/reports/daily/:date', { config: { requiredRole: 'reader' } }, async () => ({
    date: '2026-10-18',
    totalSignIns: 42,
  }))
  return { app, clock, keycloak, sessions, audit }
}

export function setCookies(response: LightMyRequestResponse): string[] {
  const header = response.headers['set-cookie']
  if (header === undefined) return []
  return Array.isArray(header) ? header : [header]
}

export function cookieValue(response: LightMyRequestResponse, name: string): string | undefined {
  for (const line of setCookies(response)) {
    const [pair] = line.split(';')
    const index = pair!.indexOf('=')
    if (pair!.slice(0, index) === name) return pair!.slice(index + 1)
  }
  return undefined
}

export async function startLogin(h: Harness, query = '') {
  const response = await h.app.inject({ method: 'GET', url: `/auth/login${query}` })
  return { response, location: String(response.headers.location), loginCookie: cookieValue(response, LOGIN_COOKIE) }
}

export async function signIn(h: Harness, user: FakeUser, options: { existingSession?: string } = {}) {
  const login = await startLogin(h)
  const { code, state } = h.keycloak.authorize(login.location, user)
  const cookies: Record<string, string> = { [LOGIN_COOKIE]: login.loginCookie ?? '' }
  if (options.existingSession) cookies[SESSION_COOKIE] = options.existingSession
  const callback = await h.app.inject({
    method: 'GET',
    url: `/auth/callback?code=${code}&state=${encodeURIComponent(state)}`,
    cookies,
  })
  return { login, callback, session: cookieValue(callback, SESSION_COOKIE) }
}

export function withSession(session: string | undefined) {
  return session === undefined ? {} : { [SESSION_COOKIE]: session }
}
