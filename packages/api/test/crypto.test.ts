/* AD-5 primitives: SHA-256 session ID hashes, AES-256-GCM sealing, PKCE S256 challenges. */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { deriveKeys, hashSessionId, pkceChallenge, randomToken, seal, unseal } from '../src/security/crypto.js'

const master = Buffer.alloc(32, 1)

describe('hashSessionId', () => {
  it('is the hex SHA-256 of the cookie value', () => {
    expect(hashSessionId('abc')).toBe(createHash('sha256').update('abc').digest('hex'))
  })
})

describe('seal and unseal', () => {
  const { refreshToken: key } = deriveKeys(master)

  it('round-trips and never contains the plaintext', () => {
    const sealed = seal(key, 'refresh-token-value', 'session-1')
    expect(sealed).not.toContain('refresh-token-value')
    expect(unseal(key, sealed, 'session-1')).toBe('refresh-token-value')
  })

  it('uses a fresh IV each time', () => {
    expect(seal(key, 'x', 'a')).not.toBe(seal(key, 'x', 'a'))
  })

  it('rejects a tampered ciphertext, a different binding or another key', () => {
    const sealed = seal(key, 'payload', 'bound')
    const bytes = Buffer.from(sealed, 'base64url')
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
    expect(unseal(key, bytes.toString('base64url'), 'bound')).toBeNull()
    expect(unseal(key, sealed, 'other')).toBeNull()
    expect(unseal(deriveKeys(Buffer.alloc(32, 2)).refreshToken, sealed, 'bound')).toBeNull()
  })

  it('rejects input too short to hold an IV and tag', () => {
    expect(unseal(key, 'abc', 'bound')).toBeNull()
    expect(unseal(key, '', 'bound')).toBeNull()
  })
})

describe('deriveKeys', () => {
  it('derives two distinct 256-bit keys and refuses a short master key', () => {
    const keys = deriveKeys(master)
    expect(keys.transaction).toHaveLength(32)
    expect(keys.refreshToken).toHaveLength(32)
    expect(keys.transaction.equals(keys.refreshToken)).toBe(false)
    expect(() => deriveKeys(Buffer.alloc(16))).toThrow()
  })
})

describe('PKCE and random tokens', () => {
  it('computes the RFC 7636 S256 challenge', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  it('makes 256-bit base64url tokens that differ each time', () => {
    const token = randomToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(randomToken()).not.toBe(token)
  })
})
