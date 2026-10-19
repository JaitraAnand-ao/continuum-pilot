import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hashSecret, open, seal } from './token-seal.js'

const key = randomBytes(32)
const aad = hashSecret('session-id')

describe('hashSecret', () => {
  it('is the 32-byte SHA-256 of the value, never the value itself', () => {
    const digest = hashSecret('abc')
    expect(digest.toString('hex')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(digest).toHaveLength(32)
  })
})

describe('seal and open (AES-256-GCM)', () => {
  it('round-trips and never holds the plaintext', () => {
    const sealed = seal(key, 'refresh-token-value', aad)
    expect(sealed.iv).toHaveLength(12)
    expect(sealed.tag).toHaveLength(16)
    expect(sealed.ciphertext.toString('utf8')).not.toContain('refresh-token-value')
    expect(open(key, sealed, aad)).toBe('refresh-token-value')
  })

  it('uses a fresh IV for every seal', () => {
    expect(seal(key, 'x', aad).iv.equals(seal(key, 'x', aad).iv)).toBe(false)
  })

  it('rejects a tampered ciphertext, tag or IV', () => {
    const sealed = seal(key, 'pkce-verifier', aad)
    const flip = (b: Buffer) => Buffer.from(b.map((v, i) => (i === 0 ? v ^ 1 : v)))
    expect(() => open(key, { ...sealed, ciphertext: flip(sealed.ciphertext) }, aad)).toThrow()
    expect(() => open(key, { ...sealed, tag: flip(sealed.tag) }, aad)).toThrow()
    expect(() => open(key, { ...sealed, iv: flip(sealed.iv) }, aad)).toThrow()
  })

  it('rejects a ciphertext moved to another row (bound by AAD)', () => {
    const sealed = seal(key, 'refresh', aad)
    expect(() => open(key, sealed, hashSecret('other-session'))).toThrow()
  })

  it('rejects the wrong key', () => {
    const sealed = seal(key, 'refresh', aad)
    expect(() => open(randomBytes(32), sealed, aad)).toThrow()
  })

  it('demands a 256-bit key: 32 bytes accepted, 31 and 33 refused', () => {
    expect(() => seal(randomBytes(32), 'x', aad)).not.toThrow()
    expect(() => seal(randomBytes(31), 'x', aad)).toThrow(RangeError)
    expect(() => seal(randomBytes(33), 'x', aad)).toThrow(RangeError)
    expect(() => open(randomBytes(31), seal(key, 'x', aad), aad)).toThrow(RangeError)
  })
})
