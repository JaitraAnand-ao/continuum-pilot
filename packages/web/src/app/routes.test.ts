import { describe, expect, it } from 'vitest'
import { formatUtc, parseLocation } from './routes'

describe('parseLocation reads the SPA addresses (IF-8)', () => {
  it('the dashboard address and the report addresses are protected app routes', () => {
    expect(parseLocation({ pathname: '/', search: '' })).toEqual({ kind: 'app', route: 'daily' })
    expect(parseLocation({ pathname: '/reports/daily', search: '?date=2026-10-18' })).toEqual({
      kind: 'app',
      route: 'daily',
    })
    expect(parseLocation({ pathname: '/reports/suspicious', search: '' })).toEqual({ kind: 'app', route: 'suspicious' })
    expect(parseLocation({ pathname: '/reports/history', search: '' })).toEqual({ kind: 'app', route: 'history' })
    expect(parseLocation({ pathname: '/somewhere/else', search: '' })).toEqual({ kind: 'app', route: 'daily' })
  })

  it('/signin is the Sign in screen', () => {
    expect(parseLocation({ pathname: '/signin', search: '' })).toEqual({ kind: 'sign-in' })
  })

  it('/signin carrying the callback error is the failed sign-in, with code, reference and time', () => {
    expect(
      parseLocation({
        pathname: '/signin',
        search: '?error=AADSTS50105&ref=7f3c9a1e-22b4-4c1e-9a65-0d2b8f1c3e77&at=2026-10-19T08%3A12%3A03Z',
      }),
    ).toEqual({
      kind: 'sign-in-error',
      error: {
        code: 'AADSTS50105',
        reference: '7f3c9a1e-22b4-4c1e-9a65-0d2b8f1c3e77',
        occurredAt: '2026-10-19T08:12:03.000Z',
      },
    })
  })

  it('keeps only what is safe to show from the callback', () => {
    expect(parseLocation({ pathname: '/signin', search: '?error=<script>&ref=&at=not-a-time' })).toEqual({
      kind: 'sign-in-error',
      error: { code: 'unknown' },
    })
  })
})

describe('formatUtc', () => {
  it('shows a copyable UTC timestamp', () => {
    expect(formatUtc('2026-10-19T08:12:03.000Z')).toBe('2026-10-19 08:12:03 UTC')
  })
})
