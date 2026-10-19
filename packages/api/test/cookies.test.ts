import { describe, expect, it } from 'vitest'
import { clearCookie, parseCookies, serializeCookie } from '../src/cookies.js'

describe('cookies', () => {
  it('parses a Cookie header, keeping the first of a repeated name', () => {
    const cookies = parseCookies('a=1; __Host-sr_session=abc.def=; junk; a=2; =x')
    expect(cookies.get('a')).toBe('1')
    expect(cookies.get('__Host-sr_session')).toBe('abc.def=')
    expect(cookies.size).toBe(2)
    expect(parseCookies(undefined).size).toBe(0)
  })

  it('always sets httpOnly, Secure and Path=/', () => {
    expect(serializeCookie('n', 'v', { sameSite: 'Strict', maxAgeSeconds: 10 })).toBe(
      'n=v; Path=/; Max-Age=10; HttpOnly; Secure; SameSite=Strict',
    )
    expect(clearCookie('n', 'Lax')).toBe('n=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax')
  })
})
