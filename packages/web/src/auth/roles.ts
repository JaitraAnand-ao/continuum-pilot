/* Presentation of the roles /api/v1/me returns. The server decides access on every route
 * (AD-7); this only chooses which navigation and role names to show. The SETTINGS group
 * for administrators arrives with ST-15. */
import type { Role } from '../api/client'
import { ROUTE_LABELS, ROUTE_PATHS, type ReportRoute } from '../app/routes'

export type NavGroup = { label: string; items: Array<{ route: ReportRoute; label: string; path: string }> }

const ADMIN_ROLES: readonly Role[] = ['config.read', 'config.write', 'config.approve']
const REPORT_ROUTES: readonly ReportRoute[] = ['daily', 'suspicious', 'history']

export const isReader = (roles: readonly Role[]) => roles.includes('reader')

export function navigationFor(roles: readonly Role[]): NavGroup[] {
  if (!isReader(roles)) return []
  return [
    {
      label: 'REPORTS',
      items: REPORT_ROUTES.map((route) => ({ route, label: ROUTE_LABELS[route], path: ROUTE_PATHS[route] })),
    },
  ]
}

export function roleNames(roles: readonly Role[]): string[] {
  const names: string[] = []
  if (isReader(roles)) names.push('Reader')
  if (roles.some((role) => ADMIN_ROLES.includes(role))) names.push('Report administrator')
  return names
}
