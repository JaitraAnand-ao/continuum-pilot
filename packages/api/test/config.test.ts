import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { Secret } from '../src/secret.js'

const env = {
  SR_PUBLIC_ORIGIN: 'https://reports.contoso.test/',
  SR_OIDC_ISSUER: 'https://keycloak.contoso.test/realms/signin-reports/',
  SR_OIDC_CLIENT_ID: 'signin-reports-bff',
  SR_OIDC_CLIENT_SECRET: 'client-secret-value',
  SR_SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
}

describe('API configuration', () => {
  it('reads the SR_ settings and wraps the secrets', () => {
    const config = loadConfig(env)
    expect(config.publicOrigin).toBe('https://reports.contoso.test')
    expect(config.oidcIssuer).toBe('https://keycloak.contoso.test/realms/signin-reports')
    expect(config.oidcClientId).toBe('signin-reports-bff')
    expect(config.port).toBe(8080)
    expect(config.oidcClientSecret).toBeInstanceOf(Secret)
    expect(config.oidcClientSecret.reveal()).toBe('client-secret-value')
    expect(Buffer.from(config.sessionEncryptionKey.reveal(), 'base64')).toHaveLength(32)
    expect(loadConfig({ ...env, SR_PORT: '9000' }).port).toBe(9000)
  })

  it('never prints a secret', () => {
    const config = loadConfig(env)
    expect(JSON.stringify(config)).not.toContain('client-secret-value')
    expect(String(config.oidcClientSecret)).toBe('[redacted]')
  })

  it('refuses a non-HTTPS origin or a short key, naming the setting but not its value', () => {
    expect(() => loadConfig({ ...env, SR_PUBLIC_ORIGIN: 'http://reports.contoso.test' })).toThrow(/SR_PUBLIC_ORIGIN/)
    const short = Buffer.alloc(31).toString('base64')
    expect(() => loadConfig({ ...env, SR_SESSION_ENCRYPTION_KEY: short })).toThrow(/SR_SESSION_ENCRYPTION_KEY/)
    expect(() => loadConfig({ ...env, SR_OIDC_CLIENT_SECRET: '' })).toThrow(/^invalid API configuration: SR_OIDC/)
  })
})
