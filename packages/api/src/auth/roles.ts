/* Who may see what (AD-7), pure: the reader role opens reports; the config.* roles make a report administrator. */
export const APP_ROLES = ['reader', 'config.read', 'config.write', 'config.approve'] as const
export type AppRole = (typeof APP_ROLES)[number]

export type Access = 'reader' | 'administrator' | 'none'

export function rolesFromClaim(claim: unknown): AppRole[] {
  if (!Array.isArray(claim)) return []
  return APP_ROLES.filter((role) => claim.includes(role))
}

export function isAdministrator(roles: readonly AppRole[]): boolean {
  return roles.some((role) => role.startsWith('config.'))
}

/* Signed-in access: a reader (with or without administration), an administrator only, or neither. */
export function accessFor(roles: readonly AppRole[]): Access {
  if (roles.includes('reader')) return 'reader'
  if (isAdministrator(roles)) return 'administrator'
  return 'none'
}

export function canReadReports(roles: readonly AppRole[]): boolean {
  return accessFor(roles) === 'reader'
}
