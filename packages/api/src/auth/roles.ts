/* The app roles Keycloak maps from Entra (reader group, report administrator app role) into the ID token's roles claim. */
export const ROLES = ['reader', 'config.read', 'config.write', 'config.approve'] as const
export type Role = (typeof ROLES)[number]

export function rolesFromClaim(claim: unknown): Role[] {
  if (!Array.isArray(claim)) return []
  return ROLES.filter((role) => claim.includes(role))
}

/* Readers and report administrators may use the dashboard; anyone else sees 'You don't have access' (AC-5). */
export function hasAnyAccess(roles: readonly Role[]): boolean {
  return roles.length > 0
}
