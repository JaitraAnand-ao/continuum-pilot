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

export type HistoryStatus = 'available' | 'generated_late' | 'not_generated'

/* IF-27 GET /api/v1/report-history: one item per UTC day, newest first. */
export interface HistoryDay {
  reportDate: string
  status: HistoryStatus
  generatedAt: string | null
  signIns: number | null
  failed: number | null
  flagCount: number | null
  emailedAt: string | null
}

export interface ReportHistory {
  totalDays: number
  firstReportDueAt: string | null
  items: HistoryDay[]
}

export type HistoryResult =
  | { kind: 'ok'; history: ReportHistory }
  | { kind: 'unauthenticated' }
  | { kind: 'forbidden' }
  | { kind: 'failed'; status: number | null; traceId: string | null }

export interface HistoryApi {
  getReportHistory(): Promise<HistoryResult>
}

export type Fetch = (input: string, init: RequestInit) => Promise<Response>

export const ME_PATH = '/api/v1/me'
/* IF-27. */
export const REPORT_HISTORY_PATH = '/api/v1/report-history'
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

function isHistory(value: unknown): value is ReportHistory {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return Array.isArray(candidate.items) && typeof candidate.totalDays === 'number'
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export function createApi(fetchImpl: Fetch): Api & HistoryApi {
  /* Every GET carries only the session cookie; null means the request never got an answer. */
  const get = async (path: string): Promise<{ response: Response; body: unknown } | null> => {
    try {
      const response = await fetchImpl(path, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json, application/problem+json' },
      })
      return { response, body: await readJson(response) }
    } catch {
      return null
    }
  }
  const failed = (response: Response, body: unknown) =>
    ({ kind: 'failed', status: response.status, traceId: isProblem(body) ? body.traceId : null }) as const
  return {
    async getMe() {
      const answer = await get(ME_PATH)
      if (answer === null) return { kind: 'failed', status: null, traceId: null }
      const { response, body } = answer
      if (response.status === 200 && body !== null) return { kind: 'ok', me: body as Me }
      if (response.status === 401) return { kind: 'unauthenticated' }
      if (response.status === 403 && isProblem(body)) return { kind: 'denied', problem: body }
      return failed(response, body)
    },
    async getReportHistory() {
      const answer = await get(REPORT_HISTORY_PATH)
      if (answer === null) return { kind: 'failed', status: null, traceId: null }
      const { response, body } = answer
      if (response.status === 200 && isHistory(body)) return { kind: 'ok', history: body }
      if (response.status === 401) return { kind: 'unauthenticated' }
      if (response.status === 403) return { kind: 'forbidden' }
      return failed(response, body)
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
