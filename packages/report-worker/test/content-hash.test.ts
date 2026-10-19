import { describe, expect, it } from 'vitest'
import { contentHash } from '../src/index.js'
import { riskDetection, signIn } from './support/fakes.js'

const a = signIn()
const b = signIn({ device: { operatingSystem: 'iOS', browser: undefined } })
const risk = riskDetection()
const base = {
  reportDate: '2026-10-11',
  windowStart: '2026-10-11T00:00:00.000Z',
  windowEnd: '2026-10-12T00:00:00.000Z',
  complete: true,
  missingSources: [],
  totals: { total: 2, successful: 2, failed: 0 },
  signIns: [a, b],
  riskDetections: [risk],
}

describe('content hash', () => {
  it('is a SHA-256 hex digest', () => {
    expect(contentHash(base)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does not depend on snapshot order, key order or absent optional fields', () => {
    const reordered = {
      ...base,
      signIns: [JSON.parse(JSON.stringify(b)), Object.fromEntries(Object.entries(a).reverse())],
    }
    expect(contentHash(reordered)).toBe(contentHash(base))
  })

  it('changes when any stored figure or sign-in changes', () => {
    expect(contentHash({ ...base, complete: false })).not.toBe(contentHash(base))
    expect(contentHash({ ...base, signIns: [a, { ...b, errorCode: 50126 }] })).not.toBe(contentHash(base))
    expect(contentHash({ ...base, riskDetections: [] })).not.toBe(contentHash(base))
  })
})
