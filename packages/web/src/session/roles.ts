/* Navigation and role names follow the roles /api/v1/me returns; the server still decides
 * access on every route (IF-4, AD-7). The SETTINGS group arrives with ST-15. */
import type { Role } from '../api/client'
import { copy } from '../copy'

export interface NavItem {
  label: string
  href: string
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

export const DAILY_REPORT_PATH = '/reports/daily'

export function navGroupsFor(roles: readonly Role[]): NavGroup[] {
  if (!roles.includes('reader')) return []
  return [
    {
      label: copy.shell.reportsGroup,
      items: [
        { label: copy.shell.dailyReport, href: DAILY_REPORT_PATH },
        { label: copy.shell.suspiciousActivity, href: '/reports/suspicious' },
        { label: copy.shell.reportHistory, href: '/reports/history' },
      ],
    },
  ]
}

export function roleNames(roles: readonly Role[]): string[] {
  const names: string[] = []
  if (roles.includes('reader')) names.push(copy.shell.reader)
  if (roles.some((role) => role.startsWith('config.'))) names.push(copy.shell.administrator)
  return names
}
