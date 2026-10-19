/* Cookie handling without a plugin. Every cookie the BFF writes is __Host- shaped: Path=/, Secure, no Domain. */
export interface CookieOptions {
  sameSite: 'Strict' | 'Lax'
  maxAge: number
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {}
  if (header === undefined) return cookies
  for (const pair of header.split(';')) {
    const trimmed = pair.trim()
    const separator = trimmed.indexOf('=')
    if (separator < 1) continue
    const name = trimmed.slice(0, separator)
    try {
      cookies[name] = decodeURIComponent(trimmed.slice(separator + 1))
    } catch {
      continue
    }
  }
  return cookies
}

export function serializeCookie(name: string, value: string, { sameSite, maxAge }: CookieOptions): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=${sameSite}`
}
