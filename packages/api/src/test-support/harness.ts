/* Test-only: one BFF wired to the fake Keycloak, an injected clock and in-memory ports. */
import { randomBytes } from 'node:crypto'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { vi } from 'vitest'
import { buildApp } from '../app.js'
import { InMemoryAuditSink } from '../audit.js'
import type { Clock } from '../clock.js'
import { loadConfig, type ApiConfig } from '../config.js'
import { createOidcClient } from '../oidc/client.js'
import { InMemorySessionStore } from '../session/store.js'
import { startFakeKeycloak, type FakeKeycloak } from './fake-keycloak.js'

/* each harness boots Fastify twice and talks real HTTP; give cold starts on slow runners room */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

export const PUBLIC_ORIGIN = 'https://reports.example.test'
export const SIGNED_IN_AT = new Date('2026-10-19T08:00:00.000Z')

export class TestClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current.getTime())
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms)
  }
  set(at: Date): void {
    this.current = new Date(at.getTime())
  }
}

export const READER = { upn: 'r.reader@contoso.com', name: 'Rita Reader', roles: ['reader'] }
export const READER_AND_ADMIN = {
  upn: 'b.both@contoso.com',
  name: 'Bo Both',
  roles: ['reader', 'config.read', 'config.write', 'config.approve'],
}
export const ADMIN_ONLY = { upn: 'a.admin@contoso.com', name: 'Ada Admin', roles: ['config.read', 'config.write'] }
export const OUTSIDER = { upn: 'o.outsider@contoso.com', name: 'Otto Outsider', roles: ['offline_access'] }

export function cookieFrom(response: LightMyRequestResponse, name: string): string | undefined {
  const header = response.headers['set-cookie']
  const all = header === undefined ? [] : Array.isArray(header) ? header : [header]
  return all.find((line) => line.startsWith(`${name}=`))
}

export function cookieValue(setCookie: string | undefined): string {
  if (setCookie === undefined) throw new Error('cookie was not set')
  return setCookie.slice(setCookie.indexOf('=') + 1).split(';')[0] as string
}

export interface LoginStart {
  response: LightMyRequestResponse
  location: URL
  loginCookie: string
}

export interface Harness {
  app: FastifyInstance
  kc: FakeKeycloak
  clock: TestClock
  sessions: InMemorySessionStore
  audit: InMemoryAuditSink
  config: ApiConfig
  startLogin(query?: string): Promise<LoginStart>
  /** Completes the callback for a started login, as Keycloak would after Microsoft sign-in. */
  completeLogin(
    start: LoginStart,
    claims: Record<string, unknown>,
    tamper?: { state?: string; codeVerifierChallenge?: string; nonce?: string; extraCookie?: string },
  ): Promise<LightMyRequestResponse>
  /** Signs in and returns the session cookie value. */
  signIn(claims: Record<string, unknown>): Promise<string>
  close(): Promise<void>
}

export const SESSION_KEY = randomBytes(32).toString('base64')

export async function createHarness(options: { routes?: (app: FastifyInstance) => void } = {}): Promise<Harness> {
  const clock = new TestClock(SIGNED_IN_AT)
  const kc = await startFakeKeycloak(() => clock.now())
  const config = loadConfig({
    SR_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    SR_OIDC_ISSUER: kc.issuer,
    SR_OIDC_CLIENT_ID: kc.clientId,
    SR_OIDC_CLIENT_SECRET: kc.clientSecret,
    SR_SESSION_KEY: SESSION_KEY,
  })
  const sessions = new InMemorySessionStore()
  const audit = new InMemoryAuditSink()
  const oidc = createOidcClient({
    issuer: config.oidcIssuer,
    clientId: config.oidcClientId,
    clientSecret: config.oidcClientSecret,
    clock,
  })
  const app = buildApp({ config, clock, sessions, audit, oidc })
  options.routes?.(app)
  await app.ready()

  const startLogin = async (query = ''): Promise<LoginStart> => {
    const response = await app.inject({ method: 'GET', url: `/auth/login${query}` })
    return {
      response,
      location: new URL(response.headers.location as string),
      loginCookie: cookieValue(cookieFrom(response, '__Host-sr_login')),
    }
  }

  const completeLogin: Harness['completeLogin'] = async (start, claims, tamper = {}) => {
    const params = start.location.searchParams
    const code = kc.issueCode({
      claims,
      nonce: tamper.nonce ?? (params.get('nonce') as string),
      codeChallenge: tamper.codeVerifierChallenge ?? (params.get('code_challenge') as string),
      redirectUri: params.get('redirect_uri') as string,
    })
    const state = tamper.state ?? (params.get('state') as string)
    const cookies = [`__Host-sr_login=${start.loginCookie}`]
    if (tamper.extraCookie !== undefined) cookies.push(tamper.extraCookie)
    return app.inject({
      method: 'GET',
      url: `/auth/callback?code=${code}&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookies.join('; ') },
    })
  }

  return {
    app,
    kc,
    clock,
    sessions,
    audit,
    config,
    startLogin,
    completeLogin,
    async signIn(claims) {
      const response = await completeLogin(await startLogin(), claims)
      return cookieValue(cookieFrom(response, '__Host-sr_session'))
    },
    async close() {
      await app.close()
      await kc.close()
    },
  }
}
