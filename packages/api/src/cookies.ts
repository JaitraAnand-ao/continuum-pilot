/* Just enough RFC 6265 for the two __Host- cookies the BFF sets: always Path=/, HttpOnly and Secure, no Domain. */
export const SESSION_COOKIE = '__Host-sr_session'
export const LOGIN_COOKIE = '__Host-sr_login'

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>()
  for (const pair of (header ?? '').split(';')) {
    const at = pair.indexOf('=')
    if (at <= 0) continue
    const name = pair.slice(0, at).trim()
    if (!cookies.has(name)) cookies.set(name, pair.slice(at + 1).trim())
  }
  return cookies
}

export function serializeCookie(
  name: string,
  value: string,
  options: { sameSite: 'Strict' | 'Lax'; maxAge?: number },
): string {
  const maxAge = options.maxAge === undefined ? '' : `; Max-Age=${options.maxAge}`
  return `${name}=${value}; Path=/${maxAge}; HttpOnly; Secure; SameSite=${options.sameSite}`
}
