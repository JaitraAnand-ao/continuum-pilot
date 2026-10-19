import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SealError, pkceChallenge, randomToken, seal, sha256Hex, unseal } from '../src/crypto.js'

describe('AD-5 primitives', () => {
  it('draws 256-bit base64url tokens that do not repeat', () => {
    const token = randomToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(randomToken()).not.toBe(token)
  })

  it('hashes with SHA-256', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('derives the PKCE S256 challenge: base64url of the SHA-256 of the verifier, unpadded', () => {
    const verifier = randomToken(48)
    const challenge = pkceChallenge(verifier)
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('seals with AES-256-GCM and opens only with the same key', () => {
    const key = randomBytes(32)
    const sealed = seal('refresh-token-value', key)
    expect(sealed).not.toContain('refresh-token-value')
    expect(sealed.split('.')).toHaveLength(4)
    expect(unseal(sealed, key)).toBe('refresh-token-value')
    expect(() => unseal(sealed, randomBytes(32))).toThrow(SealError)
  })

  it('rejects a tampered or malformed sealed value', () => {
    const key = randomBytes(32)
    const [version, iv, tag, ciphertext] = seal('value', key).split('.') as [string, string, string, string]
    const flipped = Buffer.from(ciphertext, 'base64url')
    flipped[0] = (flipped[0] ?? 0) ^ 1
    expect(() => unseal([version, iv, tag, flipped.toString('base64url')].join('.'), key)).toThrow(SealError)
    expect(() => unseal(['v0', iv, tag, ciphertext].join('.'), key)).toThrow(SealError)
    expect(() => unseal([version, iv, tag].join('.'), key)).toThrow(SealError)
    expect(() => unseal([version, iv, tag, ciphertext, 'x'].join('.'), key)).toThrow(SealError)
  })
})
