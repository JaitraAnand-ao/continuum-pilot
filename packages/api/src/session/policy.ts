/* AD-5 session limits, pure: 15 minutes idle, 8 hours absolute, the warning at least 2 minutes before idle. */
export const IDLE_LIMIT_MS = 15 * 60 * 1000
export const ABSOLUTE_LIMIT_MS = 8 * 60 * 60 * 1000
export const IDLE_WARNING_LEAD_MS = 2 * 60 * 1000

export interface SessionTimes {
  createdAt: Date
  lastSeenAt: Date
}

export type SessionState = 'active' | 'idle-expired' | 'absolute-expired'

export function idleExpiresAt(times: SessionTimes): Date {
  return new Date(Math.min(times.lastSeenAt.getTime() + IDLE_LIMIT_MS, absoluteExpiresAt(times).getTime()))
}

export function absoluteExpiresAt(times: SessionTimes): Date {
  return new Date(times.createdAt.getTime() + ABSOLUTE_LIMIT_MS)
}

/* A session is over at the limit instant itself: one millisecond before it is still active. */
export function sessionState(times: SessionTimes, now: Date): SessionState {
  if (now.getTime() >= absoluteExpiresAt(times).getTime()) return 'absolute-expired'
  if (now.getTime() >= times.lastSeenAt.getTime() + IDLE_LIMIT_MS) return 'idle-expired'
  return 'active'
}

export function idleWarningAt(times: SessionTimes): Date {
  return new Date(idleExpiresAt(times).getTime() - IDLE_WARNING_LEAD_MS)
}
