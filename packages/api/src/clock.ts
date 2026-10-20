/* Time is injected everywhere a rule depends on it, so the AD-5 limits are tested at their exact instants. */
export interface Clock {
  now(): Date
}

export const systemClock: Clock = {
  now: () => new Date(),
}
