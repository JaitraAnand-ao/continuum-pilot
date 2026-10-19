import { describe, expect, it } from 'vitest'
import { traceIdFrom } from '../src/trace.js'

describe('trace IDs', () => {
  it("continues the caller's W3C trace", () => {
    expect(traceIdFrom('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBe(
      '4bf92f3577b34da6a3ce929d0e0e4736',
    )
  })

  it('starts a new 32-hex trace when the header is absent, malformed or all zeros', () => {
    for (const header of [
      undefined,
      'garbage',
      ['a', 'b'],
      '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
    ]) {
      expect(traceIdFrom(header)).toMatch(/^[0-9a-f]{32}$/)
    }
    expect(traceIdFrom(undefined)).not.toBe(traceIdFrom(undefined))
  })
})
