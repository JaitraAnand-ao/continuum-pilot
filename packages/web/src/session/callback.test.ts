import { describe, expect, it } from 'vitest'
import { formatUtc, parseSignInFailure } from './callback'

describe('the sign-in callback error (AC-6)', () => {
  it('reads the Entra error code, the reference and a UTC timestamp', () => {
    expect(parseSignInFailure('?error=AADSTS50105&ref=7f3c2a91-0d4e&at=2026-10-19T08:00:05Z')).toEqual({
      code: 'AADSTS50105',
      reference: '7f3c2a91-0d4e',
      occurredAt: '2026-10-19 08:00:05 UTC',
    })
  })

  it('converts an offset timestamp to UTC', () => {
    expect(formatUtc('2026-10-19T10:00:05+02:00')).toBe('2026-10-19 08:00:05 UTC')
  })

  it('is absent when there is no error', () => {
    expect(parseSignInFailure('')).toBeNull()
    expect(parseSignInFailure('?ref=abc')).toBeNull()
  })

  it('ignores an error code that is not an Entra code', () => {
    expect(parseSignInFailure('?error=%3Cscript%3E')).toBeNull()
  })

  it('leaves out a malformed reference or timestamp rather than showing it', () => {
    expect(parseSignInFailure('?error=access_denied&ref=%3Cb%3E&at=yesterday')).toEqual({
      code: 'access_denied',
      reference: null,
      occurredAt: null,
    })
  })

  it('formats nothing from nothing', () => {
    expect(formatUtc(null)).toBeNull()
  })
})
