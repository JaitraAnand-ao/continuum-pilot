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

/* The top-bar name of every role in the IF-4 enum; the config.* roles are the report administrator app role. */
export const ROLE_NAMES: Readonly<Record<Role, string>> = {
  reader: copy.shell.reader,
  'config.read': copy.shell.administrator,
  'config.write': copy.shell.administrator,
  'config.approve': copy.shell.administrator,
}

export function roleNames(roles: readonly Role[]): string[] {
  return [...new Set(roles.map((role) => ROLE_NAMES[role]))]
}
