/* config-through-schema: secrets are wrapped so they never reach a log line, a JSON body or util.inspect. */
const REDACTED = '[redacted]'

export class Secret<T = string> {
  readonly #value: T

  constructor(value: T) {
    this.#value = value
  }

  reveal(): T {
    return this.#value
  }

  toString(): string {
    return REDACTED
  }

  toJSON(): string {
    return REDACTED
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED
  }
}
