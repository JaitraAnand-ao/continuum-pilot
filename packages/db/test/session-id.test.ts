import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hashSessionId } from '../src/session-store.js'

describe('hashSessionId (AD-5: only the SHA-256 of the session ID is stored)', () => {
  it('is the 32-byte SHA-256 digest of the cookie value', () => {
    const id = 'kq3v0mVx7y0n1d3Z8s2Qd8l5pE0hJ6gS4a9wB2cF1tE'
    const hash = hashSessionId(id)
    expect(hash).toHaveLength(32)
    expect(hash.equals(createHash('sha256').update(id, 'utf8').digest())).toBe(true)
  })

  it('maps distinct session IDs to distinct hashes and never echoes the ID', () => {
    const a = hashSessionId('session-a')
    expect(a.equals(hashSessionId('session-a'))).toBe(true)
    expect(a.equals(hashSessionId('session-b'))).toBe(false)
    expect(a.toString('utf8')).not.toContain('session-a')
  })

  it('refuses an empty session ID', () => {
    expect(() => hashSessionId('')).toThrow(/session ID/)
  })
})
