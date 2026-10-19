/* AD-5 session limits (ST-1 AC-9). Pure: every instant comes in as an argument. */
export const IDLE_TIMEOUT_MS = 15 * 60_000
export const ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60_000
/* The SPA opens the 'Stay signed in' dialog this long before idleExpiresAt. */
export const IDLE_WARNING_LEAD_MS = 2 * 60_000
export const LOGIN_TRANSACTION_TTL_MS = 5 * 60_000

export interface SessionTimes {
  createdAt: Date
  lastSeenAt: Date
}

export type SessionStatus = 'active' | 'idle-expired' | 'absolute-expired'

export function sessionExpiry({ createdAt, lastSeenAt }: SessionTimes): {
  idleExpiresAt: Date
  absoluteExpiresAt: Date
} {
  const absolute = createdAt.getTime() + ABSOLUTE_TIMEOUT_MS
  const idle = Math.min(lastSeenAt.getTime() + IDLE_TIMEOUT_MS, absolute)
  return { idleExpiresAt: new Date(idle), absoluteExpiresAt: new Date(absolute) }
}

export function sessionStatus(times: SessionTimes, now: Date): SessionStatus {
  const { idleExpiresAt, absoluteExpiresAt } = sessionExpiry(times)
  if (now.getTime() >= absoluteExpiresAt.getTime()) return 'absolute-expired'
  if (now.getTime() >= idleExpiresAt.getTime()) return 'idle-expired'
  return 'active'
}

export function loginTransactionExpired(createdAt: Date, now: Date): boolean {
  const age = now.getTime() - createdAt.getTime()
  return age < 0 || age >= LOGIN_TRANSACTION_TTL_MS
}
