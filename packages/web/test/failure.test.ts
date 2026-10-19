import { describe, expect, it } from 'vitest'
import { formatUtc, parseSignInFailure } from '../src/session/failure'

const NOW = Date.parse('2026-10-19T09:30:05Z')

describe('AC-6 the callback error the BFF hands back', () => {
  it('shows the Entra error code, reference and UTC time', () => {
    expect(
      parseSignInFailure('?error=AADSTS50105&ref=4bf92f3577b34da6a3ce929d0e0e4736&at=2026-10-19T09:29:58Z', NOW),
    ).toEqual({
      code: 'AADSTS50105',
      reference: '4bf92f3577b34da6a3ce929d0e0e4736',
      occurredAt: '2026-10-19 09:29:58 UTC',
    })
  })

  it('falls back when values are missing', () => {
    expect(parseSignInFailure('', NOW)).toEqual({
      code: 'unknown',
      reference: 'unavailable',
      occurredAt: '2026-10-19 09:30:05 UTC',
    })
  })

  it('never shows text injected into the address', () => {
    const failure = parseSignInFailure('?error=Call+0800+now&ref=<script>&at=yesterday', NOW)
    expect(failure.code).toBe('unknown')
    expect(failure.reference).toBe('unavailable')
    expect(failure.occurredAt).toBe('2026-10-19 09:30:05 UTC')
  })

  it('formats instants in UTC', () => {
    expect(formatUtc(Date.parse('2026-01-02T03:04:05.678+02:00'))).toBe('2026-01-02 01:04:05 UTC')
  })
})
