/* AD-7: the server decides access on every route from the roles in the session. */
export const ROLES = ['reader', 'config.read', 'config.write', 'config.approve'] as const
export type Role = (typeof ROLES)[number]

/** What a route needs: nothing, any of the app roles, or one role in particular. */
export type RouteAccess = 'public' | 'signed-in' | Role

export type AccessDecision = 'allow' | 'unauthenticated' | 'no-access' | 'forbidden'

const isRole = (value: unknown): value is Role => (ROLES as readonly unknown[]).includes(value)

/** The app roles in a validated ID token's roles claim; anything else is ignored. */
export function rolesFromClaims(claims: Record<string, unknown>): Role[] {
  const claimed = Array.isArray(claims.roles) ? (claims.roles as unknown[]) : []
  return [...new Set(claimed.filter(isRole))]
}

/** roles is null when there is no session. */
export function decideAccess(roles: readonly Role[] | null, required: RouteAccess): AccessDecision {
  if (required === 'public') return 'allow'
  if (roles === null) return 'unauthenticated'
  if (roles.length === 0) return 'no-access'
  if (required === 'signed-in' || roles.includes(required)) return 'allow'
  return 'forbidden'
}
