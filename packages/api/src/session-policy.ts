/* AD-5 session limits: 15 minutes idle, 8 hours absolute, both measured with the injected Clock. */
export const IDLE_LIMIT_MS = 15 * 60 * 1000
export const ABSOLUTE_LIMIT_MS = 8 * 60 * 60 * 1000

export interface SessionTimes {
  createdAt: Date
  lastSeenAt: Date
}

export function idleExpiresAt(times: SessionTimes): Date {
  return new Date(times.lastSeenAt.getTime() + IDLE_LIMIT_MS)
}

export function absoluteExpiresAt(times: SessionTimes): Date {
  return new Date(times.createdAt.getTime() + ABSOLUTE_LIMIT_MS)
}

/* A session is over at the limit instant itself, not one millisecond after it. */
export function isSessionExpired(times: SessionTimes, now: Date): boolean {
  const at = now.getTime()
  return at >= idleExpiresAt(times).getTime() || at >= absoluteExpiresAt(times).getTime()
}
