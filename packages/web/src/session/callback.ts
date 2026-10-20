/* IF-3: when Microsoft returns an error, the BFF callback redirects to /sign-in with the Entra error
 * code (error), its own error reference (ref) and when it happened (at, ISO 8601 UTC). */

export interface SignInFailure {
  code: string
  reference: string | null
  occurredAt: string | null
}

const ENTRA_CODE = /^[A-Za-z0-9_.-]{1,64}$/
const REFERENCE = /^[A-Za-z0-9-]{1,64}$/

export function parseSignInFailure(search: string): SignInFailure | null {
  const params = new URLSearchParams(search)
  const code = params.get('error')
  if (code === null || !ENTRA_CODE.test(code)) return null
  const reference = params.get('ref')
  return {
    code,
    reference: reference !== null && REFERENCE.test(reference) ? reference : null,
    occurredAt: formatUtc(params.get('at')),
  }
}

/* 2026-10-19 08:00:00 UTC */
export function formatUtc(value: string | null): string | null {
  if (value === null) return null
  const time = Date.parse(value)
  if (Number.isNaN(time)) return null
  return `${new Date(time).toISOString().slice(0, 19).replace('T', ' ')} UTC`
}
