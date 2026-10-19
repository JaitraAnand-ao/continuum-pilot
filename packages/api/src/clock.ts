/* The injected Clock: every session-limit decision takes its instant from here, never from Date.now(). */
export interface Clock {
  now(): Date
}

export const systemClock: Clock = { now: () => new Date() }
