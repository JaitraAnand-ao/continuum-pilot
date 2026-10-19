/* config-through-schema: a secret never prints itself, so it cannot reach a log line or a span. */
export class Secret {
  readonly #value: string

  constructor(value: string) {
    this.#value = value
  }

  reveal(): string {
    return this.#value
  }

  toString(): string {
    return '[redacted]'
  }

  toJSON(): string {
    return '[redacted]'
  }
}
