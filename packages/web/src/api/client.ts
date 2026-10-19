/* The SPA's calls to the BFF, typed from IF-1 (start sign-in), IF-4 (current account) and IF-5 (sign out).
 * They live here only until packages/api-client is generated from packages/api/openapi.json (AD-3).
 * The session is the httpOnly '__Host-sr_session' cookie the browser sends on its own; no token is
 * ever read, stored or forwarded by this code (AD-5). */

export type Role = 'reader' | 'config.read' | 'config.write' | 'config.approve'

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
  { status: 200; me: Me } | { status: 401 } | { status: 403; problem: Problem } | { status: 'error' }

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

const ROLES: readonly string[] = ['reader', 'config.read', 'config.write', 'config.approve']
const NO_ACCESS_TITLE = /^You don't have access\. Signed in as \S+@\S+\.$/
const RETURN_TO = /^\/[^/\\].*$|^\/$/
const TRACE_ID = /^[0-9a-f]{32}$/

function hex(bytes: number): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes))
  return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('')
}

/* W3C trace context, so each call from the SPA starts the trace the BFF continues. */
export function traceparent(): string {
  return `00-${hex(16)}-${hex(8)}-01`
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isDateTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value))

function isMe(body: unknown): body is Me {
  if (!isRecord(body)) return false
  const { account, displayName, roles, authTime, idleExpiresAt, absoluteExpiresAt } = body
  return (
    typeof account === 'string' &&
    typeof displayName === 'string' &&
    Array.isArray(roles) &&
    roles.every((role) => typeof role === 'string' && ROLES.includes(role)) &&
    isDateTime(authTime) &&
    isDateTime(idleExpiresAt) &&
    isDateTime(absoluteExpiresAt)
  )
}

function isNoAccessProblem(body: unknown): body is Problem {
  return (
    isRecord(body) &&
    body.type === '/problems/no-access' &&
    typeof body.title === 'string' &&
    NO_ACCESS_TITLE.test(body.title) &&
    body.status === 403 &&
    typeof body.traceId === 'string' &&
    TRACE_ID.test(body.traceId)
  )
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

const browserFetch: FetchLike = (input, init) => globalThis.fetch(input, init)

/* IF-4 GET /api/v1/me — every documented status maps to its own result; anything else is 'error'. */
export async function getMe(fetchImpl: FetchLike = browserFetch): Promise<MeResult> {
  let response: Response
  try {
    response = await fetchImpl('/api/v1/me', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json, application/problem+json', traceparent: traceparent() },
    })
  } catch {
    return { status: 'error' }
  }
  if (response.status === 401) return { status: 401 }
  const body = await readJson(response)
  if (response.status === 200 && isMe(body)) return { status: 200, me: body }
  if (response.status === 403 && isNoAccessProblem(body)) return { status: 403, problem: body }
  return { status: 'error' }
}

/* IF-1 GET /auth/login — a full-page navigation, so only the URL is built here. */
export function loginUrl(returnTo?: string): string {
  if (returnTo === undefined || returnTo === '/' || returnTo.length > 512 || !RETURN_TO.test(returnTo)) {
    return '/auth/login'
  }
  return `/auth/login?${new URLSearchParams({ returnTo }).toString()}`
}

/* IF-5 POST /auth/logout — ends the server session and clears the cookie. True when the BFF confirmed it. */
export async function logout(fetchImpl: FetchLike = browserFetch): Promise<boolean> {
  try {
    const response = await fetchImpl('/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { traceparent: traceparent() },
    })
    return response.ok || response.status === 401
  } catch {
    return false
  }
}
