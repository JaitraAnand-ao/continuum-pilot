/** The only source of "now" for the stores: injected so expiry is provable at its edges. */
export interface Clock {
  now(): Date
}
