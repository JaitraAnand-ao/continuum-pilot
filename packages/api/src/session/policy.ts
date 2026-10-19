/* AD-5 session limits: 15 minutes idle, 8 hours absolute. Pure: the caller supplies the instant. */
export const IDLE_LIMIT_MS = 15 * 60 * 1000
export const ABSOLUTE_LIMIT_MS = 8 * 60 * 60 * 1000

export interface SessionTimes {
  createdAt: Date
  lastSeenAt: Date
}

export type SessionState = 'active' | 'idle-expired' | 'absolute-expired'

export function sessionState(times: SessionTimes, now: Date): SessionState {
  if (now.getTime() - times.createdAt.getTime() >= ABSOLUTE_LIMIT_MS) return 'absolute-expired'
  if (now.getTime() - times.lastSeenAt.getTime() >= IDLE_LIMIT_MS) return 'idle-expired'
  return 'active'
}

export function sessionExpiries(times: SessionTimes): { idleExpiresAt: Date; absoluteExpiresAt: Date } {
  const absolute = times.createdAt.getTime() + ABSOLUTE_LIMIT_MS
  const idle = Math.min(times.lastSeenAt.getTime() + IDLE_LIMIT_MS, absolute)
  return { idleExpiresAt: new Date(idle), absoluteExpiresAt: new Date(absolute) }
}
