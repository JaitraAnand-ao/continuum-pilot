/* The one source of "now" for the BFF, injected so the AD-5 limits are testable at their edges. */
export interface Clock {
  now(): Date
}

export const systemClock: Clock = { now: () => new Date(Date.now()) }
