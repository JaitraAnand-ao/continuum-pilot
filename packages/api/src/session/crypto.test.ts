import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { deriveKey, hashSessionId, newSessionId, openToken, sealToken } from './crypto.js'

describe('AD-5 session cryptography', () => {
  it('mints 256-bit URL-safe session IDs that never repeat', () => {
    const first = newSessionId()
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newSessionId()).not.toBe(first)
  })

  it('hashes a session ID with SHA-256', () => {
    expect(hashSessionId('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('seals with AES-256-GCM so the plaintext is not in the ciphertext and it opens again', () => {
    const key = randomBytes(32)
    const sealed = sealToken(key, 'rt-secret-refresh-token', 'refresh-token')
    expect(sealed).not.toContain('rt-secret')
    expect(sealToken(key, 'rt-secret-refresh-token', 'refresh-token')).not.toBe(sealed)
    expect(openToken(key, sealed, 'refresh-token')).toBe('rt-secret-refresh-token')
  })

  it('refuses a tampered ciphertext, a different purpose or a different key', () => {
    const key = randomBytes(32)
    const sealed = sealToken(key, 'payload', 'refresh-token')
    const bytes = Buffer.from(sealed, 'base64url')
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 1
    expect(() => openToken(key, bytes.toString('base64url'), 'refresh-token')).toThrow()
    expect(() => openToken(key, sealed, 'login-transaction')).toThrow()
    expect(() => openToken(randomBytes(32), sealed, 'refresh-token')).toThrow()
    expect(() => openToken(key, 'short', 'refresh-token')).toThrow()
  })

  it('derives distinct 256-bit keys per purpose from one master key', () => {
    const master = randomBytes(32)
    const a = deriveKey(master, 'refresh-token')
    expect(a).toHaveLength(32)
    expect(deriveKey(master, 'refresh-token').equals(a)).toBe(true)
    expect(deriveKey(master, 'login-transaction').equals(a)).toBe(false)
  })
})
