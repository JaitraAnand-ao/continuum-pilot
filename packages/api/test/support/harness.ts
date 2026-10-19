/* Builds the BFF against the fake Keycloak with an injected, hand-moved Clock and in-memory stores. */
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { vi } from 'vitest'
import { buildApp, type ReportReader } from '../../src/app.js'
import { InMemoryAuditSink } from '../../src/audit.js'
import { KeycloakOidcClient } from '../../src/auth/oidc.js'
import type { Clock } from '../../src/clock.js'
import { Secret } from '../../src/secret.js'
import { InMemorySessionStore } from '../../src/session/store.js'
import { CLIENT_ID, CLIENT_SECRET, FakeKeycloak } from './fake-keycloak.js'

/* Each test starts a Fastify instance and a local HTTP server; slow CI runners need more than the 5 s default. */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

export const ORIGIN = 'https://reports.contoso.test'

export class ManualClock implements Clock {
  #now: number

  constructor(start: string) {
    this.#now = Date.parse(start)
  }

  now(): Date {
    return new Date(this.#now)
  }

  set(instant: string | number): void {
    this.#now = typeof instant === 'number' ? instant : Date.parse(instant)
  }

  advance(ms: number): void {
    this.#now += ms
  }
}

export const READER = { preferred_username: 'm.duarte@contoso.com', name: 'Marta Duarte', roles: ['reader'] }
export const READER_ADMIN = {
  preferred_username: 'a.okafor@contoso.com',
  name: 'Ada Okafor',
  roles: ['reader', 'config.read', 'config.write', 'offline_access'],
}
export const ADMIN_ONLY = { preferred_username: 'j.lee@contoso.com', name: 'Jin Lee', roles: ['config.read'] }
export const OUTSIDER = { preferred_username: 'k.brown@contoso.com', name: 'Kim Brown', roles: ['default-roles'] }

export interface Harness {
  app: FastifyInstance
  keycloak: FakeKeycloak
  clock: ManualClock
  sessions: InMemorySessionStore
  audit: InMemoryAuditSink
  sessionKey: Secret<Buffer>
  close(): Promise<void>
}

export async function startHarness(options: { reports?: ReportReader; start?: string } = {}): Promise<Harness> {
  const keycloak = await new FakeKeycloak().start()
  const clock = new ManualClock(options.start ?? '2026-10-19T08:00:00.000Z')
  keycloak.nowMs = () => clock.now().getTime()
  const sessions = new InMemorySessionStore()
  const audit = new InMemoryAuditSink()
  const sessionKey = new Secret(randomBytes(32))
  const oidc = new KeycloakOidcClient({
    issuer: keycloak.issuer,
    clientId: CLIENT_ID,
    clientSecret: new Secret(CLIENT_SECRET),
    redirectUri: `${ORIGIN}/auth/callback`,
    idpHint: 'microsoft',
  })
  const app = buildApp({
    oidc,
    sessions,
    audit,
    clock,
    sessionKey,
    ...(options.reports ? { reports: options.reports } : {}),
  })
  await app.ready()
  return {
    app,
    keycloak,
    clock,
    sessions,
    audit,
    sessionKey,
    close: async () => {
      await app.close()
      await keycloak.stop()
    },
  }
}

export function setCookies(headers: Record<string, unknown>): string[] {
  const value = headers['set-cookie']
  if (value === undefined) return []
  return Array.isArray(value) ? value.map(String) : [String(value)]
}

export function cookieValue(setCookie: string[], name: string): string | undefined {
  const line = setCookie.find((cookie) => cookie.startsWith(`${name}=`))
  return line?.slice(name.length + 1).split(';')[0]
}

/* Runs the whole browser round-trip: /auth/login, Keycloak's code for these claims, /auth/callback. */
export async function signIn(
  harness: Harness,
  claims: Record<string, unknown>,
  options: { returnTo?: string; cookie?: string } = {},
) {
  const query = options.returnTo ? `?returnTo=${encodeURIComponent(options.returnTo)}` : ''
  const login = await harness.app.inject({ method: 'GET', url: `/auth/login${query}` })
  const loginCookie = cookieValue(setCookies(login.headers), '__Host-sr_login')
  const { code, state } = harness.keycloak.issueCode(String(login.headers.location), claims)
  const cookie = [`__Host-sr_login=${loginCookie}`, ...(options.cookie ? [options.cookie] : [])].join('; ')
  const callback = await harness.app.inject({
    method: 'GET',
    url: `/auth/callback?code=${code}&state=${state}`,
    headers: { cookie },
  })
  const session = cookieValue(setCookies(callback.headers), '__Host-sr_session')
  return { login, callback, session, sessionCookie: `__Host-sr_session=${session}` }
}
