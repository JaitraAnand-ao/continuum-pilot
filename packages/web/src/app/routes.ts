/* IF-8: the SPA's addresses. The report routes are protected (the session is checked on
 * every load); /signin is the Sign in screen, and the BFF callback (IF-3) returns a failed
 * Microsoft sign-in to /signin?error=<Entra code>&ref=<reference>&at=<UTC ISO time>.
 * A completed sign-in returns to the IF-1 returnTo, which the SPA marks with
 * ?from=microsoft so the access check after the callback can be told apart from a
 * plain load (AC-4). */
export type ReportRoute = 'daily' | 'suspicious' | 'history'

export const ROUTE_PATHS: Record<ReportRoute, string> = {
  daily: '/reports/daily',
  suspicious: '/reports/suspicious',
  history: '/reports/history',
}

export const ROUTE_LABELS: Record<ReportRoute, string> = {
  daily: 'Daily report',
  suspicious: 'Suspicious activity',
  history: 'Report history',
}

export const SIGN_IN_PATH = '/signin'

const RETURN_MARKER = { name: 'from', value: 'microsoft' }

/** The IF-1 returnTo for a route: its path, marked as the return from Microsoft. */
export const returnPath = (route: ReportRoute) => `${ROUTE_PATHS[route]}?${RETURN_MARKER.name}=${RETURN_MARKER.value}`

export type CallbackError = { code: string; reference?: string; occurredAt?: string }

export type Destination =
  | { kind: 'app'; route: ReportRoute; returning?: true }
  | { kind: 'sign-in' }
  | { kind: 'sign-in-error'; error: CallbackError }

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/
const SAFE_REFERENCE = /^[A-Za-z0-9-]{1,64}$/

function callbackError(query: URLSearchParams): CallbackError {
  const code = query.get('error') ?? ''
  const reference = query.get('ref') ?? ''
  const at = Date.parse(query.get('at') ?? '')
  const error: CallbackError = { code: SAFE_CODE.test(code) ? code : 'unknown' }
  if (SAFE_REFERENCE.test(reference)) error.reference = reference
  if (!Number.isNaN(at)) error.occurredAt = new Date(at).toISOString()
  return error
}

export function parseLocation({ pathname, search }: { pathname: string; search: string }): Destination {
  if (pathname === SIGN_IN_PATH) {
    const query = new URLSearchParams(search)
    return query.has('error') ? { kind: 'sign-in-error', error: callbackError(query) } : { kind: 'sign-in' }
  }
  const route = (Object.keys(ROUTE_PATHS) as ReportRoute[]).find((key) => ROUTE_PATHS[key] === pathname)
  const destination: Destination = { kind: 'app', route: route ?? 'daily' }
  if (new URLSearchParams(search).get(RETURN_MARKER.name) === RETURN_MARKER.value) destination.returning = true
  return destination
}

/** '2026-10-19 08:12:03 UTC' */
export const formatUtc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`

/** '08:15 UTC' */
export const formatUtcTime = (iso: string) => `${new Date(iso).toISOString().slice(11, 16)} UTC`
