/* The BFF calls ST-1 makes: IF-1 (start sign-in), IF-4 (GET /api/v1/me) and IF-5 (sign out).
 * Session state lives only in the BFF's httpOnly __Host-sr_session cookie (AC-8): the SPA
 * sends it with same-origin credentials and never reads, stores or receives a token. */

export const ROLES = ['reader', 'config.read', 'config.write', 'config.approve'] as const
export type Role = (typeof ROLES)[number]

export interface Me {
  account: string
  displayName: string
  roles: Role[]
  authTime: string
  idleExpiresAt: string
  absoluteExpiresAt: string
}

export interface Problem {
  type: string
  title: string
  status: number
  traceId: string
}

export type MeResult =
  | { status: 'ok'; me: Me }
  | { status: 'unauthenticated' }
  | { status: 'forbidden'; problem: Problem | null }
  | { status: 'unavailable' }

export interface ApiClient {
  getMe(): Promise<MeResult>
  signOut(): Promise<void>
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

const isString = (value: unknown): value is string => typeof value === 'string'
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export function isMe(value: unknown): value is Me {
  return (
    isRecord(value) &&
    isString(value.account) &&
    isString(value.displayName) &&
    Array.isArray(value.roles) &&
    value.roles.every((role) => (ROLES as readonly unknown[]).includes(role)) &&
    isString(value.authTime) &&
    isString(value.idleExpiresAt) &&
    isString(value.absoluteExpiresAt)
  )
}

export function isProblem(value: unknown): value is Problem {
  return (
    isRecord(value) &&
    isString(value.type) &&
    isString(value.title) &&
    typeof value.status === 'number' &&
    isString(value.traceId)
  )
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

export function createApiClient(fetchImpl: Fetch): ApiClient {
  return {
    async getMe() {
      let response: Response
      try {
        response = await fetchImpl('/api/v1/me', {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { Accept: 'application/json, application/problem+json' },
        })
      } catch {
        return { status: 'unavailable' }
      }
      if (response.status === 401) return { status: 'unauthenticated' }
      if (response.status === 403) {
        const body = await readJson(response)
        return { status: 'forbidden', problem: isProblem(body) ? body : null }
      }
      if (response.status === 200) {
        const body = await readJson(response)
        if (isMe(body)) return { status: 'ok', me: body }
      }
      return { status: 'unavailable' }
    },
    async signOut() {
      try {
        await fetchImpl('/auth/logout', { method: 'POST', credentials: 'same-origin' })
      } catch {
        /* The cookie is httpOnly, so the SPA cannot clear it; the BFF's idle limit ends it. */
      }
    },
  }
}

export interface LoginOptions {
  returnTo?: string
  maxAge?: number
}

/* IF-1 is a top-level navigation (302 to Keycloak), never a fetch. */
export function loginUrl(options: LoginOptions = {}): string {
  const query = new URLSearchParams()
  if (options.returnTo !== undefined) query.set('returnTo', options.returnTo)
  if (options.maxAge !== undefined) query.set('maxAge', String(options.maxAge))
  const search = query.toString()
  return search ? `/auth/login?${search}` : '/auth/login'
}
