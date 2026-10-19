/* The injected Clock: every session limit is measured against it, never against the wall clock directly. */
export interface Clock {
  now(): Date
}

export const systemClock: Clock = { now: () => new Date() }
