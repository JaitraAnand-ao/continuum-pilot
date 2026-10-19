import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { open, pkceChallenge, randomToken, safeEqual, seal, sha256Hex } from './crypto'

describe('crypto helpers', () => {
  it('produces distinct URL-safe random tokens of at least 256 bits', () => {
    const a = randomToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43,}$/)
    expect(randomToken()).not.toBe(a)
  })

  it('hashes with SHA-256 in hex', () => {
    expect(sha256Hex('abc')).toBe(createHash('sha256').update('abc').digest('hex'))
  })

  it('derives the RFC 7636 S256 challenge', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  it('seals with AES-256-GCM and opens only with the same key and untouched ciphertext', () => {
    const key = randomBytes(32)
    const sealed = seal(key, 'refresh-token')
    expect(sealed).not.toContain('refresh-token')
    expect(seal(key, 'refresh-token')).not.toBe(sealed)
    expect(open(key, sealed)).toBe('refresh-token')
    expect(open(randomBytes(32), sealed)).toBeNull()
    const bytes = Buffer.from(sealed, 'base64url')
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1
    expect(open(key, bytes.toString('base64url'))).toBeNull()
    expect(open(key, 'short')).toBeNull()
  })

  it('compares strings in constant time and refuses different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })
})
