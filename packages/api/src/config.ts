/* The BFF's settings, read only here and only from SR_ environment variables. */
import { z } from 'zod'

export class Secret<T> {
  readonly #value: T
  constructor(value: T) {
    this.#value = value
  }
  reveal(): T {
    return this.#value
  }
  toString(): string {
    return '[redacted]'
  }
  toJSON(): string {
    return '[redacted]'
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[redacted]'
  }
}

const schema = z.object({
  SR_OIDC_ISSUER: z.url(),
  SR_OIDC_CLIENT_ID: z.string().min(1),
  SR_OIDC_CLIENT_SECRET: z.string().min(1),
  SR_PUBLIC_ORIGIN: z.url({ protocol: /^https$/ }),
  SR_SESSION_KEY: z
    .base64()
    .refine((value) => Buffer.from(value, 'base64').length === 32, 'SR_SESSION_KEY must decode to 32 bytes'),
})

export interface ApiConfig {
  oidcIssuer: string
  oidcClientId: string
  oidcClientSecret: Secret<string>
  publicOrigin: string
  sessionKey: Secret<Buffer>
}

export function loadConfig(env: Record<string, string | undefined>): ApiConfig {
  const parsed = schema.parse(env)
  return {
    oidcIssuer: parsed.SR_OIDC_ISSUER,
    oidcClientId: parsed.SR_OIDC_CLIENT_ID,
    oidcClientSecret: new Secret(parsed.SR_OIDC_CLIENT_SECRET),
    publicOrigin: new URL(parsed.SR_PUBLIC_ORIGIN).origin,
    sessionKey: new Secret(Buffer.from(parsed.SR_SESSION_KEY, 'base64')),
  }
}
