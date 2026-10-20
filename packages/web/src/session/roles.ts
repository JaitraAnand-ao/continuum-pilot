/* Navigation and role names follow the roles /api/v1/me returns (UQ-4); the server still decides access. */
import type { Role } from '../api/client'

export interface NavItem {
  label: string
  path: string
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

export const DAILY_REPORT_PATH = '/reports/daily'
export const HISTORY_PAGE_PATH = '/reports/history'

export const REPORTS_GROUP: NavGroup = {
  label: 'REPORTS',
  items: [
    { label: 'Daily report', path: DAILY_REPORT_PATH },
    { label: 'Suspicious activity', path: '/reports/suspicious' },
    { label: 'Report history', path: HISTORY_PAGE_PATH },
  ],
}

const ADMIN_ROLES: readonly Role[] = ['config.read', 'config.write', 'config.approve']

export const isReader = (roles: readonly Role[]): boolean => roles.includes('reader')

export const isReportAdministrator = (roles: readonly Role[]): boolean =>
  roles.some((role) => ADMIN_ROLES.includes(role))

/* The names the top bar shows for the claims the account holds (AC-3). */
export function roleNames(roles: readonly Role[]): string[] {
  const names: string[] = []
  if (isReader(roles)) names.push('Reader')
  if (isReportAdministrator(roles)) names.push('Report administrator')
  return names
}

/* The SETTINGS group for administrators is delivered by ST-15. */
export function navigationFor(roles: readonly Role[]): NavGroup[] {
  return isReader(roles) ? [REPORTS_GROUP] : []
}
