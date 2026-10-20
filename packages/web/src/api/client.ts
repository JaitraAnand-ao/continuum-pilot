/* The SPA's only HTTP boundary (AD-3). packages/api-client is still empty, so this module is the
 * single place fetch is called; every call sends the httpOnly session cookie and never a token (AC-8). */

export type Role = 'reader' | 'config.read' | 'config.write' | 'config.approve'

/* IF-4 GET /api/v1/me 200 body. */
export interface Me {
  account: string
  displayName: string
  roles: Role[]
  authTime: string
  idleExpiresAt: string
  absoluteExpiresAt: string
}

/* RFC 9457 problem+json as the contracts define it: only type, title, status and traceId. */
export interface Problem {
  type: string
  title: string
  status: number
  traceId: string
}

export type MeResult =
  | { kind: 'ok'; me: Me }
  | { kind: 'unauthenticated' }
  | { kind: 'denied'; problem: Problem }
  | { kind: 'failed'; status: number | null; traceId: string | null }

export interface Api {
  getMe(): Promise<MeResult>
  signOut(): Promise<boolean>
}

export type Fetch = (input: string, init: RequestInit) => Promise<Response>

export const ME_PATH = '/api/v1/me'
/* IF-1. */
export const LOGIN_PATH = '/auth/login'
/* IF-5: ends the BFF session and clears __Host-sr_session. */
export const LOGOUT_PATH = '/auth/logout'

/* IF-1 returnTo: a same-origin path, at most 512 characters. */
const RETURN_TO = /^\/[^/\\].*$|^\/$/

export function loginUrl(returnTo?: string): string {
  if (returnTo === undefined || returnTo.length > 512 || !RETURN_TO.test(returnTo)) return LOGIN_PATH
  return `${LOGIN_PATH}?${new URLSearchParams({ returnTo }).toString()}`
}

function isProblem(value: unknown): value is Problem {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.type === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.status === 'number' &&
    typeof candidate.traceId === 'string'
  )
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export function createApi(fetchImpl: Fetch): Api {
  return {
    async getMe() {
      let response: Response
      try {
        response = await fetchImpl(ME_PATH, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { accept: 'application/json, application/problem+json' },
        })
      } catch {
        return { kind: 'failed', status: null, traceId: null }
      }
      const body = await readJson(response)
      if (response.status === 200 && body !== null) return { kind: 'ok', me: body as Me }
      if (response.status === 401) return { kind: 'unauthenticated' }
      if (response.status === 403 && isProblem(body)) return { kind: 'denied', problem: body }
      return { kind: 'failed', status: response.status, traceId: isProblem(body) ? body.traceId : null }
    },
    async signOut() {
      try {
        const response = await fetchImpl(LOGOUT_PATH, { method: 'POST', credentials: 'same-origin' })
        /* 401 means the session had already ended: the outcome the user asked for. */
        return response.ok || response.status === 401
      } catch {
        return false
      }
    },
  }
}
