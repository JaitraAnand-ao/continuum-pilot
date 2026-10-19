import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createServer } from '../src/server.js'
import { dailyReport } from './support/harness.js'

/* Building the first Fastify instance of a run is slow on a cold CI worker. */
vi.setConfig({ testTimeout: 30_000 })

const config = loadConfig({
  SR_PUBLIC_ORIGIN: 'https://reports.contoso.test',
  SR_OIDC_ISSUER: 'https://keycloak.contoso.test/realms/signin-reports',
  SR_OIDC_CLIENT_ID: 'signin-reports-bff',
  SR_OIDC_CLIENT_SECRET: 'client-secret-value',
  SR_SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
})

describe('the composed server', () => {
  it('signs in through Keycloak at the configured issuer, with the callback on the public origin', async () => {
    const fetch = async () =>
      Response.json({
        authorization_endpoint: 'https://keycloak.contoso.test/auth',
        token_endpoint: 'https://keycloak.contoso.test/token',
        end_session_endpoint: 'https://keycloak.contoso.test/logout',
        jwks_uri: 'https://keycloak.contoso.test/certs',
      })
    const app = createServer(config, { fetch, reportRoutes: dailyReport })
    const response = await app.inject({ method: 'GET', url: '/auth/login' })
    const location = new URL(String(response.headers.location))
    expect(location.origin).toBe('https://keycloak.contoso.test')
    expect(location.searchParams.get('redirect_uri')).toBe('https://reports.contoso.test/auth/callback')
    expect((await app.inject({ method: 'GET', url: '/api/v1/reports/daily/2026-10-18' })).statusCode).toBe(401)
  })

  it('defaults to the global fetch and system clock', async () => {
    const app = createServer(config)
    expect((await app.inject({ method: 'GET', url: '/api/v1/me' })).statusCode).toBe(401)
  })
})
