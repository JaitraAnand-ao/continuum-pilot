/* Time is injected everywhere a rule depends on it, so tests can stand at any instant. */
export interface Clock {
  now(): Date
}

export const systemClock: Clock = { now: () => new Date(Date.now()) }
