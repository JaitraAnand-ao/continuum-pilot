import type { Clock } from '../../src/clock.js'

export class FixedClock implements Clock {
  #at: number

  constructor(iso: string) {
    this.#at = Date.parse(iso)
  }

  now(): Date {
    return new Date(this.#at)
  }

  advance(ms: number): void {
    this.#at += ms
  }
}
