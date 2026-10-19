/* The SPA's calls to the BFF: IF-4 (who am I), IF-1 (start sign-in) and IF-5 (sign out).
 * The browser's only credential is the httpOnly '__Host-sr_session' cookie, sent by the
 * browser itself on same-origin requests (AC-8); nothing here reads or stores a token.
 * Typed from the pinned contract copies beside this file until packages/api-client is
 * generated from packages/api/openapi.json. */
export const ROLES = ['reader', 'config.read', 'config.write', 'config.approve'] as const
export type Role = (typeof ROLES)[number]

export type Me = {
  account: string
  displayName: string
  roles: Role[]
  authTime: string
  idleExpiresAt: string
  absoluteExpiresAt: string
}

export type MeResult =
  | { kind: 'signed-in'; me: Me }
  | { kind: 'signed-out' }
  | { kind: 'no-access'; title: string }
  | { kind: 'unavailable'; traceId?: string }

export interface ApiClient {
  getMe(): Promise<MeResult>
  signOut(): Promise<void>
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/* IF-1's returnTo pattern: a same-origin path, never protocol-relative. */
const RETURN_TO = /^\/[^/\\].*$|^\/$/

export function loginHref({ returnTo, maxAge }: { returnTo?: string; maxAge?: number }): string {
  const query = new URLSearchParams()
  if (returnTo !== undefined && RETURN_TO.test(returnTo)) query.set('returnTo', returnTo)
  if (maxAge !== undefined) query.set('maxAge', String(maxAge))
  const search = query.toString()
  return search ? `/auth/login?${search}` : '/auth/login'
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isDateTime = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value))

function parseMe(body: unknown): Me | undefined {
  if (!isRecord(body)) return undefined
  const { account, displayName, roles, authTime, idleExpiresAt, absoluteExpiresAt } = body
  if (typeof account !== 'string' || typeof displayName !== 'string') return undefined
  if (!Array.isArray(roles) || !roles.every((role) => (ROLES as readonly unknown[]).includes(role))) return undefined
  if (!isDateTime(authTime) || !isDateTime(idleExpiresAt) || !isDateTime(absoluteExpiresAt)) return undefined
  return body as Me
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

const unavailable = (body: unknown): MeResult =>
  isRecord(body) && typeof body.traceId === 'string'
    ? { kind: 'unavailable', traceId: body.traceId }
    : { kind: 'unavailable' }

export function createApiClient(fetch: Fetch): ApiClient {
  return {
    async getMe() {
      let response: Response
      try {
        response = await fetch('/api/v1/me', {
          method: 'GET',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
          cache: 'no-store',
        })
      } catch {
        return { kind: 'unavailable' }
      }
      const body = await readJson(response)
      if (response.status === 200) {
        const me = parseMe(body)
        return me ? { kind: 'signed-in', me } : { kind: 'unavailable' }
      }
      if (response.status === 401) return { kind: 'signed-out' }
      if (
        response.status === 403 &&
        isRecord(body) &&
        body.type === '/problems/no-access' &&
        typeof body.title === 'string'
      ) {
        return { kind: 'no-access', title: body.title }
      }
      return unavailable(body)
    },

    async signOut() {
      try {
        await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' })
      } catch {
        /* The server session expires on its own; the browser leaves it either way. */
      }
    },
  }
}
