import { describe, expect, it } from 'vitest'
import { contentHash, totalsOf } from '../src/index.js'
import { signIn } from './support.js'

describe('totals reconcile to the snapshot', () => {
  it('counts errorCode 0 as successful and any other code as failed', () => {
    const snapshot = [
      signIn({ id: 'a', errorCode: 0 }),
      signIn({ id: 'b', errorCode: 50126 }),
      signIn({ id: 'c', errorCode: 1 }),
      signIn({ id: 'd', errorCode: 0 }),
    ]
    const totals = totalsOf(snapshot)
    expect(totals).toEqual({ total: 4, successful: 2, failed: 2 })
    expect(totals.successful + totals.failed).toBe(snapshot.length)
  })

  it('is zero for an empty snapshot (AC-7)', () => {
    expect(totalsOf([])).toEqual({ total: 0, successful: 0, failed: 0 })
  })
})

describe('content hash', () => {
  it('ignores key order and changes with content', () => {
    const a = contentHash({ b: 1, a: [{ y: 2, x: 1 }] })
    expect(a).toBe(contentHash({ a: [{ x: 1, y: 2 }], b: 1 }))
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(contentHash({ a: [{ x: 1, y: 3 }], b: 1 }))
  })

  it('treats a missing key differently from a null one and keeps array order', () => {
    expect(contentHash({ a: null })).not.toBe(contentHash({}))
    expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]))
  })
})
