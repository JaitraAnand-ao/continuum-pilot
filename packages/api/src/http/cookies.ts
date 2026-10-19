/* The two cookies the BFF sets. Both are __Host- prefixed: Secure, Path=/, no Domain (AD-5). */
export const SESSION_COOKIE = '__Host-sr_session'
export const LOGIN_COOKIE = '__Host-sr_login'

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return undefined
}

export function serializeCookie(
  name: string,
  value: string,
  sameSite: 'Strict' | 'Lax',
  maxAgeSeconds: number,
): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${maxAgeSeconds}`
}

export function clearCookie(name: string, sameSite: 'Strict' | 'Lax'): string {
  return serializeCookie(name, '', sameSite, 0)
}
