/* Entra app roles, carried through Keycloak in the ID token's roles claim, mapped to the IF-4 roles. */
export type Role = 'reader' | 'config.read' | 'config.write' | 'config.approve'

export const READER_APP_ROLE = 'SignInReports.Reader'
export const ADMIN_APP_ROLE = 'SignInReports.Admin'

const ORDER: readonly Role[] = ['reader', 'config.read', 'config.write', 'config.approve']

const GRANTS: Record<string, readonly Role[]> = {
  [READER_APP_ROLE]: ['reader'],
  [ADMIN_APP_ROLE]: ['config.read', 'config.write', 'config.approve'],
}

export function rolesFromClaims(claims: { roles?: unknown }): Role[] {
  if (!Array.isArray(claims.roles)) return []
  const granted = new Set<Role>()
  for (const claim of claims.roles) {
    if (typeof claim !== 'string') continue
    for (const role of GRANTS[claim] ?? []) granted.add(role)
  }
  return ORDER.filter((role) => granted.has(role))
}

export function hasAnyAccess(roles: readonly Role[]): boolean {
  return roles.length > 0
}
