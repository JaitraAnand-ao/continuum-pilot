/* AD-5 primitives: hashed session IDs, AES-256-GCM sealing bound to its purpose, PKCE S256. */
import { randomBytes } from 'node:crypto'
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { open, pkceChallenge, randomToken, safeEqual, seal, sha256Hex } from '../src/crypto.js'
import { Secret } from '../src/secret.js'

const key = new Secret(randomBytes(32))

describe('crypto', () => {
  it('makes 256-bit url-safe random tokens that do not repeat', () => {
    const token = randomToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(randomToken()).not.toBe(token)
  })

  it('hashes with SHA-256', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('derives the RFC 7636 S256 challenge', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  it('compares in constant time and refuses different lengths', () => {
    expect(safeEqual('state', 'state')).toBe(true)
    expect(safeEqual('state', 'statE')).toBe(false)
    expect(safeEqual('state', 'stat')).toBe(false)
  })

  it('seals with AES-256-GCM and opens only with the same key and purpose', () => {
    const sealed = seal(key, 'refresh-token', 'session-hash')
    expect(sealed).not.toContain('refresh-token')
    expect(open(key, sealed, 'session-hash')).toBe('refresh-token')
    expect(open(key, sealed, 'other-session')).toBeUndefined()
    expect(open(new Secret(randomBytes(32)), sealed, 'session-hash')).toBeUndefined()
  })

  it('refuses a tampered or truncated ciphertext', () => {
    const raw = Buffer.from(seal(key, 'refresh-token', 'aad'), 'base64url')
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1
    expect(open(key, raw.toString('base64url'), 'aad')).toBeUndefined()
    expect(open(key, 'c2hvcnQ', 'aad')).toBeUndefined()
  })

  it('never prints a secret', () => {
    const secret = new Secret('client-secret-value')
    expect(String(secret)).toBe('[redacted]')
    expect(JSON.stringify({ secret })).toBe('{"secret":"[redacted]"}')
    expect(inspect({ secret })).not.toContain('client-secret-value')
    expect(secret.reveal()).toBe('client-secret-value')
  })
})
