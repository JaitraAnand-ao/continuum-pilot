/* Time is injected: nothing in the worker reads the system clock or sleeps on its own. */
export interface Clock {
  now(): Date
}

export interface Sleeper {
  sleep(milliseconds: number): Promise<void>
}
