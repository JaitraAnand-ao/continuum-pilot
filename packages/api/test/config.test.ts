/* config-through-schema: the BFF reads its settings only through the SR_ Zod schema; secrets stay wrapped. */
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

const env = {
  SR_PUBLIC_ORIGIN: 'https://reports.contoso.test/',
  SR_OIDC_ISSUER: 'https://auth.contoso.test/realms/signin-reports/',
  SR_OIDC_CLIENT_ID: 'signin-reports-bff',
  SR_OIDC_CLIENT_SECRET: 'client-secret-value',
  SR_SESSION_KEY: randomBytes(32).toString('base64'),
}

describe('loadConfig', () => {
  it('reads the SR_ settings and derives the callback address', () => {
    const config = loadConfig(env)
    expect(config.publicOrigin).toBe('https://reports.contoso.test')
    expect(config.redirectUri).toBe('https://reports.contoso.test/auth/callback')
    expect(config.oidc.issuer).toBe('https://auth.contoso.test/realms/signin-reports')
    expect(config.oidc.idpHint).toBe('microsoft')
    expect(config.oidc.clientSecret.reveal()).toBe('client-secret-value')
    expect(config.sessionKey.reveal()).toHaveLength(32)
    expect(JSON.stringify(config)).not.toContain('client-secret-value')
  })

  it('refuses a session key that is not 32 bytes, naming the field but not its value', () => {
    expect(() => loadConfig({ ...env, SR_SESSION_KEY: randomBytes(16).toString('base64') })).toThrow(
      /invalid API configuration: SR_SESSION_KEY$/,
    )
  })

  it('refuses missing settings and non-http origins', () => {
    expect(() => loadConfig({ ...env, SR_OIDC_CLIENT_SECRET: undefined })).toThrow(/SR_OIDC_CLIENT_SECRET/)
    expect(() => loadConfig({ ...env, SR_PUBLIC_ORIGIN: 'javascript:alert(1)' })).toThrow(/SR_PUBLIC_ORIGIN/)
  })
})
