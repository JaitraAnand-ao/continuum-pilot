import { describe, expect, it } from 'vitest'
import { parseCookies, serializeCookie } from './cookies'

describe('cookies', () => {
  it('parses a Cookie header and ignores malformed pairs', () => {
    expect(parseCookies('a=1; __Host-sr_session=abc%3D; junk; =x')).toEqual({ a: '1', '__Host-sr_session': 'abc=' })
    expect(parseCookies(undefined)).toEqual({})
    expect(parseCookies('bad=%E0%A4%A')).toEqual({})
  })

  it('always writes __Host- compatible, httpOnly, Secure cookies', () => {
    expect(serializeCookie('__Host-sr_session', 'v', { sameSite: 'Strict', maxAge: 28800 })).toBe(
      '__Host-sr_session=v; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Strict',
    )
    expect(serializeCookie('__Host-sr_login', '', { sameSite: 'Lax', maxAge: 0 })).toBe(
      '__Host-sr_login=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    )
  })
})
