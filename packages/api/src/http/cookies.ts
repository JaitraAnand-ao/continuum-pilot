/* The two AD-5 cookies: the Strict session cookie and the 5-minute Lax login-transaction cookie. */
export const SESSION_COOKIE = '__Host-sr_session'
export const LOGIN_COOKIE = '__Host-sr_login'
export const LOGIN_TRANSACTION_SECONDS = 300

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim()
      return value === '' ? undefined : value
    }
  }
  return undefined
}

export function sessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
}

export function loginCookie(value: string): string {
  return `${LOGIN_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${LOGIN_TRANSACTION_SECONDS}`
}

export function clearLoginCookie(): string {
  return `${LOGIN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}
