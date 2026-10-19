/* Session limits come from the server (/api/v1/me idleExpiresAt and absoluteExpiresAt,
 * AD-5); the SPA only schedules the warning ahead of them. */
import type { Me } from '../api/client'

/** The idle warning shows at least this long before the idle limit (AC-9). */
export const WARNING_LEAD_MS = 2 * 60_000

export function sessionTimers(me: Me, now: number): { warnInMs: number | null; endInMs: number } {
  const idleAt = Date.parse(me.idleExpiresAt)
  const absoluteAt = Date.parse(me.absoluteExpiresAt)
  const endAt = Math.min(idleAt, absoluteAt)
  return {
    warnInMs: idleAt <= absoluteAt ? Math.max(0, idleAt - WARNING_LEAD_MS - now) : null,
    endInMs: Math.max(0, endAt - now),
  }
}
