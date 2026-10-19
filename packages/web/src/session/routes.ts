import { REPORTS_GROUP } from './roles'

export const APP_NAME = 'Entra Sign-In Reports'

export const pageTitle = (name: string): string => `${name} – ${APP_NAME}`

/* Paths that only start or end the sign-in flow; every other path is a page of the dashboard. */
const ENTRY_PATHS = new Set(['/', '/sign-in'])

export const isEntryPath = (path: string): boolean => ENTRY_PATHS.has(path)

export interface Page {
  path: string
  heading: string
  requiresReader: boolean
}

export const NOT_AVAILABLE: Page = { path: '', heading: "This page isn't available", requiresReader: false }

export function pageFor(path: string): Page {
  const item = REPORTS_GROUP.items.find((candidate) => candidate.path === path)
  return item ? { path: item.path, heading: item.label, requiresReader: true } : { ...NOT_AVAILABLE, path }
}
