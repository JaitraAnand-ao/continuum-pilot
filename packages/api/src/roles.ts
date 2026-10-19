/* App roles carried in the validated Keycloak token. 'reader' opens the reports; the config.* roles are the
 * report administrator's. Anyone holding none of them is the AC-5 "neither group" account. */
export const ROLES = ['reader', 'config.read', 'config.write', 'config.approve'] as const
export type Role = (typeof ROLES)[number]

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

/* Unknown values are dropped rather than trusted; the result is unique and in ROLES order. */
export function rolesFromClaim(claim: unknown): Role[] {
  if (!Array.isArray(claim)) return []
  const held = new Set(claim.filter(isRole))
  return ROLES.filter((role) => held.has(role))
}

export function hasAnyAccess(roles: readonly Role[]): boolean {
  return roles.length > 0
}

export function hasRole(roles: readonly Role[], role: Role): boolean {
  return roles.includes(role)
}
