import type { Role } from '../api/client'

/* Navigation and role names follow the roles /api/v1/me returns; the server still decides access
 * on every route (AD-7). The SETTINGS group arrives with ST-15. */

export type ScreenId = 'daily' | 'suspicious' | 'history' | 'settings'

export interface NavItem {
  screen: ScreenId
  label: string
  href: string
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

export const SCREENS: Record<ScreenId, { heading: string; href: string }> = {
  daily: { heading: 'Daily report', href: '/reports/daily' },
  suspicious: { heading: 'Suspicious activity', href: '/reports/suspicious' },
  history: { heading: 'Report history', href: '/reports/history' },
  settings: { heading: 'Detection settings', href: '/settings/detection' },
}

const REPORT_SCREENS: ScreenId[] = ['daily', 'suspicious', 'history']

const isReader = (roles: readonly Role[]): boolean => roles.includes('reader')

const isAdministrator = (roles: readonly Role[]): boolean => roles.some((role) => role.startsWith('config.'))

export function navGroups(roles: readonly Role[]): NavGroup[] {
  if (!isReader(roles)) return []
  return [
    {
      label: 'REPORTS',
      items: REPORT_SCREENS.map((screen) => ({ screen, label: SCREENS[screen].heading, href: SCREENS[screen].href })),
    },
  ]
}

export function roleLabels(roles: readonly Role[]): string[] {
  const labels: string[] = []
  if (isReader(roles)) labels.push('Reader')
  if (isAdministrator(roles)) labels.push('Report administrator')
  return labels
}

/* Readers land on the Daily report; an administrator-only account lands on Detection settings (ST-15). */
export function screenFor(pathname: string, roles: readonly Role[]): ScreenId {
  if (!isReader(roles)) return 'settings'
  return REPORT_SCREENS.find((screen) => SCREENS[screen].href === pathname) ?? 'daily'
}
