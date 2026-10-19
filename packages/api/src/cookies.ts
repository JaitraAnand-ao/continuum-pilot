/* AD-5 cookies. Both carry the __Host- prefix, so both are Secure, Path=/ and host-only; both are httpOnly. */
export const SESSION_COOKIE = '__Host-sr_session'
export const LOGIN_COOKIE = '__Host-sr_login'
export const LOGIN_COOKIE_MAX_AGE_S = 300

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>()
  if (!header) return cookies
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=')
    if (index < 0) continue
    const name = pair.slice(0, index).trim()
    if (name && !cookies.has(name)) cookies.set(name, pair.slice(index + 1).trim())
  }
  return cookies
}

export interface CookieOptions {
  sameSite: 'Strict' | 'Lax'
  maxAgeSeconds: number
}

/* Values are base64url or sealed tokens, so they never need encoding. */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  return `${name}=${value}; Path=/; Max-Age=${options.maxAgeSeconds}; HttpOnly; Secure; SameSite=${options.sameSite}`
}

export function clearCookie(name: string, sameSite: CookieOptions['sameSite']): string {
  return serializeCookie(name, '', { sameSite, maxAgeSeconds: 0 })
}
