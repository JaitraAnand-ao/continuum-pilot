/** The injected source of the current instant; nothing in this package reads the system clock. */
export interface Clock {
  now(): Date
}
