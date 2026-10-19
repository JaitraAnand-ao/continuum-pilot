import type { Me } from '../api/client'

/* The limits themselves come from /api/v1/me; the SPA only warns ahead of the idle one (AC-9). */

export const IDLE_WARNING_LEAD_MS = 2 * 60 * 1000

export type SessionPhase = 'active' | 'warning' | 'expired'

function limits(me: Me): { idle: number; absolute: number; end: number } {
  const idle = Date.parse(me.idleExpiresAt)
  const absolute = Date.parse(me.absoluteExpiresAt)
  return { idle, absolute, end: Math.min(idle, absolute) }
}

export function sessionPhase(me: Me, now: number): SessionPhase {
  const { idle, absolute, end } = limits(me)
  if (now >= end) return 'expired'
  if (idle <= absolute && now >= idle - IDLE_WARNING_LEAD_MS) return 'warning'
  return 'active'
}

/* Milliseconds until sessionPhase next changes, or null once the session has ended. */
export function msUntilPhaseChange(me: Me, now: number): number | null {
  const { idle, absolute, end } = limits(me)
  if (now >= end) return null
  const warnAt = idle - IDLE_WARNING_LEAD_MS
  const next = idle <= absolute && now < warnAt ? warnAt : end
  return next - now
}

/* 'HH:MM' in UTC, for the idle warning. */
export function utcClock(iso: string): string {
  return new Date(iso).toISOString().slice(11, 16)
}
