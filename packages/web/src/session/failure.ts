/* AC-6: the BFF's sign-in callback (IF-3) redirects a failed Microsoft sign-in to SIGN_IN_ERROR_PATH
 * with the Entra error code, its error reference and when it happened. Values are shown, never interpreted. */

export const SIGN_IN_ERROR_PATH = '/signin/error'

export interface SignInFailure {
  code: string
  reference: string
  occurredAt: string
}

const SAFE_VALUE = /^[A-Za-z0-9_.:-]{1,64}$/

export function formatUtc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`
}

export function parseSignInFailure(search: string, now: number): SignInFailure {
  const params = new URLSearchParams(search)
  const shown = (name: string, fallback: string): string => {
    const value = params.get(name)
    return value !== null && SAFE_VALUE.test(value) ? value : fallback
  }
  const at = Date.parse(params.get('at') ?? '')
  return {
    code: shown('error', 'unknown'),
    reference: shown('ref', 'unavailable'),
    occurredAt: formatUtc(Number.isNaN(at) ? now : at),
  }
}
