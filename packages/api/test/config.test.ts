/* Settings are read only through the Zod config, SR_ prefixed, with secrets wrapped. */
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { loadConfig, Secret } from '../src/config.js'
import { TEST_ENV } from './support/harness.js'

describe('loadConfig', () => {
  it('reads the SR_ settings and wraps the secrets', () => {
    const config = loadConfig(TEST_ENV)
    expect(config.publicOrigin).toBe('https://reports.contoso.test')
    expect(config.oidc.issuer).toBe(TEST_ENV.SR_OIDC_ISSUER)
    expect(config.oidc.clientId).toBe(TEST_ENV.SR_OIDC_CLIENT_ID)
    expect(config.oidc.idpHint).toBe('microsoft')
    expect(config.oidc.clientSecret).toBeInstanceOf(Secret)
    expect(config.oidc.clientSecret.reveal()).toBe(TEST_ENV.SR_OIDC_CLIENT_SECRET)
    expect(config.sessionKey.reveal()).toHaveLength(32)
  })

  it('accepts an IdP hint override and strips a trailing slash from the origin and issuer', () => {
    const config = loadConfig({
      ...TEST_ENV,
      SR_PUBLIC_ORIGIN: 'https://reports.contoso.test/',
      SR_OIDC_ISSUER: `${TEST_ENV.SR_OIDC_ISSUER}/`,
      SR_OIDC_IDP_HINT: 'entra',
    })
    expect(config.publicOrigin).toBe('https://reports.contoso.test')
    expect(config.oidc.issuer).toBe(TEST_ENV.SR_OIDC_ISSUER)
    expect(config.oidc.idpHint).toBe('entra')
  })

  it('names the bad settings without echoing their values', () => {
    expect(() => loadConfig({ ...TEST_ENV, SR_OIDC_CLIENT_SECRET: '', SR_SESSION_KEY: 'c2hvcnQ=' })).toThrow(
      /SR_OIDC_CLIENT_SECRET.*SR_SESSION_KEY|SR_SESSION_KEY.*SR_OIDC_CLIENT_SECRET/,
    )
    try {
      loadConfig({ ...TEST_ENV, SR_SESSION_KEY: 'c2hvcnQ=' })
    } catch (problem) {
      expect(String(problem)).not.toContain('c2hvcnQ=')
    }
  })

  it('refuses a public origin that is not https', () => {
    expect(() => loadConfig({ ...TEST_ENV, SR_PUBLIC_ORIGIN: 'http://reports.contoso.test' })).toThrow(
      /SR_PUBLIC_ORIGIN/,
    )
  })
})

describe('Secret', () => {
  it('never prints its value', () => {
    const secret = new Secret('hunter2')
    expect(String(secret)).toBe('[secret]')
    expect(JSON.stringify({ secret })).toBe('{"secret":"[secret]"}')
    expect(inspect(secret)).not.toContain('hunter2')
  })
})
