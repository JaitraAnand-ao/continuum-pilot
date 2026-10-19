import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { Secret, loadConfig } from './config'

const key = Buffer.alloc(32, 7).toString('base64')
const env = {
  SR_OIDC_ISSUER: 'https://sso.example.test/realms/signin-reports',
  SR_OIDC_CLIENT_ID: 'signin-reports-bff',
  SR_OIDC_CLIENT_SECRET: 'client-secret',
  SR_PUBLIC_ORIGIN: 'https://reports.example.test',
  SR_SESSION_KEY: key,
}

describe('loadConfig', () => {
  it('reads the SR_ settings and wraps secrets', () => {
    const config = loadConfig(env)
    expect(config.oidcIssuer).toBe(env.SR_OIDC_ISSUER)
    expect(config.oidcClientId).toBe('signin-reports-bff')
    expect(config.publicOrigin).toBe('https://reports.example.test')
    expect(config.oidcClientSecret).toBeInstanceOf(Secret)
    expect(config.oidcClientSecret.reveal()).toBe('client-secret')
    expect(config.sessionKey.reveal()).toEqual(Buffer.alloc(32, 7))
  })

  it('never prints a secret', () => {
    const config = loadConfig(env)
    expect(JSON.stringify(config)).not.toContain('client-secret')
    expect(String(config.oidcClientSecret)).toBe('[redacted]')
    expect(inspect(config)).not.toContain('client-secret')
  })

  it('refuses a session key that is not 32 bytes, a non-https origin and missing settings', () => {
    expect(() => loadConfig({ ...env, SR_SESSION_KEY: Buffer.alloc(16).toString('base64') })).toThrow()
    expect(() => loadConfig({ ...env, SR_PUBLIC_ORIGIN: 'http://reports.example.test' })).toThrow()
    expect(() => loadConfig({ ...env, SR_OIDC_ISSUER: undefined })).toThrow()
  })
})
