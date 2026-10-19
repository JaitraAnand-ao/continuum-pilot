import { randomBytes } from 'node:crypto'
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

const key = randomBytes(32).toString('base64')
const env = {
  SR_PUBLIC_ORIGIN: 'https://reports.example.test',
  SR_OIDC_ISSUER: 'https://idp.example.test/realms/signin-reports',
  SR_OIDC_CLIENT_ID: 'signin-reports-bff',
  SR_OIDC_CLIENT_SECRET: 'super-secret-value',
  SR_SESSION_KEY: key,
}

describe('API configuration through the SR_ schema', () => {
  it('loads the settings and defaults the identity-provider hint to microsoft', () => {
    const config = loadConfig(env)
    expect(config.publicOrigin).toBe('https://reports.example.test')
    expect(config.oidcIssuer).toBe('https://idp.example.test/realms/signin-reports')
    expect(config.oidcClientId).toBe('signin-reports-bff')
    expect(config.oidcIdpHint).toBe('microsoft')
    expect(config.oidcClientSecret.reveal()).toBe('super-secret-value')
    expect(config.sessionKey.reveal()).toHaveLength(32)
    expect(loadConfig({ ...env, SR_OIDC_IDP_HINT: 'entra' }).oidcIdpHint).toBe('entra')
  })

  it('never prints a secret', () => {
    const config = loadConfig(env)
    const printed = `${JSON.stringify(config)} ${inspect(config)} ${String(config.oidcClientSecret)}`
    expect(printed).not.toContain('super-secret-value')
    expect(printed).not.toContain(key)
  })

  it('names the bad variables without echoing their values', () => {
    expect(() => loadConfig({ ...env, SR_SESSION_KEY: 'dG9vLXNob3J0', SR_PUBLIC_ORIGIN: undefined })).toThrow(
      /SR_PUBLIC_ORIGIN.*SR_SESSION_KEY|SR_SESSION_KEY.*SR_PUBLIC_ORIGIN/,
    )
    expect(() => loadConfig({ ...env, SR_SESSION_KEY: 'dG9vLXNob3J0' })).not.toThrow(/dG9vLXNob3J0/)
  })

  it('requires an https public origin, since the session cookie is __Host- and Secure', () => {
    expect(() => loadConfig({ ...env, SR_PUBLIC_ORIGIN: 'http://reports.example.test' })).toThrow(/SR_PUBLIC_ORIGIN/)
  })
})
