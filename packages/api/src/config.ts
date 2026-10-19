/* The API's settings, read only from SR_ environment variables through one Zod schema. Secrets stay wrapped. */
import { inspect } from 'node:util'
import { z } from 'zod'

/** Holds a secret so that logging, JSON or string conversion never prints it. */
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
  [inspect.custom](): string {
    return 'Secret([redacted])'
  }
}

const schema = z.object({
  SR_PUBLIC_ORIGIN: z.url({ protocol: /^https$/ }).transform((value) => new URL(value).origin),
  SR_OIDC_ISSUER: z.url().transform((value) => value.replace(/\/+$/, '')),
  SR_OIDC_CLIENT_ID: z.string().min(1),
  SR_OIDC_CLIENT_SECRET: z.string().min(1),
  SR_OIDC_IDP_HINT: z.string().min(1).default('microsoft'),
  SR_SESSION_KEY: z
    .string()
    .transform((value) => Buffer.from(value, 'base64'))
    .refine((key) => key.length === 32, 'must be 32 bytes, base64-encoded'),
})

export interface ApiConfig {
  publicOrigin: string
  oidcIssuer: string
  oidcClientId: string
  oidcClientSecret: Secret<string>
  oidcIdpHint: string
  sessionKey: Secret<Buffer>
}

export function loadConfig(env: Record<string, string | undefined>): ApiConfig {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))].sort()
    throw new Error(`invalid API configuration: ${names.join(', ')}`)
  }
  const values = parsed.data
  return {
    publicOrigin: values.SR_PUBLIC_ORIGIN,
    oidcIssuer: values.SR_OIDC_ISSUER,
    oidcClientId: values.SR_OIDC_CLIENT_ID,
    oidcClientSecret: new Secret(values.SR_OIDC_CLIENT_SECRET),
    oidcIdpHint: values.SR_OIDC_IDP_HINT,
    sessionKey: new Secret(values.SR_SESSION_KEY),
  }
}
