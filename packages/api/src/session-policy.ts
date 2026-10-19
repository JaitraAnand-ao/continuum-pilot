/* AD-5 session limits (ST-1 AC-9). Pure: the caller supplies "now". */
export const IDLE_LIMIT_MS = 15 * 60 * 1000
export const ABSOLUTE_LIMIT_MS = 8 * 60 * 60 * 1000
export const IDLE_WARNING_LEAD_MS = 2 * 60 * 1000

export interface SessionTimes {
  createdAt: Date
  lastSeenAt: Date
}

export interface SessionLimits {
  idleExpiresAt: Date
  idleWarningAt: Date
  absoluteExpiresAt: Date
}

export function sessionLimits({ createdAt, lastSeenAt }: SessionTimes): SessionLimits {
  const idleExpiresAt = lastSeenAt.getTime() + IDLE_LIMIT_MS
  return {
    idleExpiresAt: new Date(idleExpiresAt),
    idleWarningAt: new Date(idleExpiresAt - IDLE_WARNING_LEAD_MS),
    absoluteExpiresAt: new Date(createdAt.getTime() + ABSOLUTE_LIMIT_MS),
  }
}

/* A session is over from the instant a limit is reached, not one tick after. */
export function expiryReason(times: SessionTimes, now: Date): 'idle' | 'absolute' | null {
  const limits = sessionLimits(times)
  if (now.getTime() >= limits.absoluteExpiresAt.getTime()) return 'absolute'
  if (now.getTime() >= limits.idleExpiresAt.getTime()) return 'idle'
  return null
}
