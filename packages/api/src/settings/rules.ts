/* ST-15 detection-settings rules, pure: no I/O and no clock of their own; the caller passes the instant (AD-2).
 * Tightening (a lower count or a wider window) applies at once as a new config version; loosening waits for ST-16. */
export const THRESHOLD_KEYS = ['repeated_failures', 'password_spray'] as const
export type ThresholdKey = (typeof THRESHOLD_KEYS)[number]

export interface Threshold {
  count: number
  windowMinutes: number
}

export interface ThresholdSetting extends Threshold {
  inEffectSince: Date
}

export interface SensitiveApp {
  appId: string
  appName: string
  addedBy: string
  addedAt: Date
}

export interface ConfigVersion {
  id: string
  previousId: string | null
  createdAt: Date
  createdBy: string | null
  thresholds: Record<ThresholdKey, ThresholdSetting>
  sensitiveApps: SensitiveApp[]
}

/* Who makes a new version, when, and under which ID. */
export interface VersionStamp {
  id: string
  at: Date
  by: string
}

export const DEFAULT_THRESHOLDS: Readonly<Record<ThresholdKey, Readonly<Threshold>>> = {
  repeated_failures: { count: 10, windowMinutes: 60 },
  password_spray: { count: 10, windowMinutes: 60 },
}

/* A window longer than the report day would reach into sign-ins the daily snapshot does not hold. */
export const MAX_WINDOW_MINUTES = 1440

export const COUNT_MESSAGE = 'Enter a whole number of 1 or more'
export const WINDOW_MESSAGE = `Enter a whole number of minutes from 1 to ${MAX_WINDOW_MINUTES}`
export const UNKNOWN_APP_MESSAGE = "That isn't an application ID seen in this tenant's sign-ins"

export type ThresholdValidation =
  { ok: true; threshold: Threshold } | { ok: false; field: keyof Threshold; message: string }

function wholeNumberFrom(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

export function validateThreshold(input: { count: unknown; windowMinutes: unknown }): ThresholdValidation {
  const { count, windowMinutes } = input
  if (!wholeNumberFrom(count, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, field: 'count', message: COUNT_MESSAGE }
  if (!wholeNumberFrom(windowMinutes, 1, MAX_WINDOW_MINUTES)) {
    return { ok: false, field: 'windowMinutes', message: WINDOW_MESSAGE }
  }
  return { ok: true, threshold: { count, windowMinutes } }
}

export type ChangeDirection = 'tighten' | 'loosen' | 'unchanged'

/* Stricter means more flags: fewer events needed, or more time to gather them. Any loosening half needs approval. */
export function classifyThresholdChange(current: Threshold, proposed: Threshold): ChangeDirection {
  if (proposed.count > current.count || proposed.windowMinutes < current.windowMinutes) return 'loosen'
  if (proposed.count === current.count && proposed.windowMinutes === current.windowMinutes) return 'unchanged'
  return 'tighten'
}

export function initialVersion(id: string, at: Date): ConfigVersion {
  const setting = (key: ThresholdKey): ThresholdSetting => ({ ...DEFAULT_THRESHOLDS[key], inEffectSince: at })
  return {
    id,
    previousId: null,
    createdAt: at,
    createdBy: null,
    thresholds: { repeated_failures: setting('repeated_failures'), password_spray: setting('password_spray') },
    sensitiveApps: [],
  }
}

function nextVersion(current: ConfigVersion, stamp: VersionStamp): ConfigVersion {
  return {
    ...current,
    id: stamp.id,
    previousId: current.id,
    createdAt: stamp.at,
    createdBy: stamp.by,
  }
}

export function withThreshold(
  current: ConfigVersion,
  key: ThresholdKey,
  threshold: Threshold,
  stamp: VersionStamp,
): ConfigVersion {
  return {
    ...nextVersion(current, stamp),
    thresholds: { ...current.thresholds, [key]: { ...threshold, inEffectSince: stamp.at } },
  }
}

export function withSensitiveApp(
  current: ConfigVersion,
  app: Omit<SensitiveApp, 'addedAt'>,
  stamp: VersionStamp,
): ConfigVersion {
  return {
    ...nextVersion(current, stamp),
    sensitiveApps: [...current.sensitiveApps, { ...app, addedAt: stamp.at }],
  }
}

export function isSensitive(version: ConfigVersion, appId: string): boolean {
  return version.sensitiveApps.some((app) => app.appId === appId)
}

/* The daily report for UTC day D is built after D ends, so a change saved during D applies from D's report. */
export function reportDateFor(at: Date): string {
  return at.toISOString().slice(0, 10)
}
