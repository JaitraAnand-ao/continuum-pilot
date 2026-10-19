/* The BFF's settings, read only here, from SR_ environment variables. Security-relevant settings are environment-only. */
import { inspect } from 'node:util'
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
    return '[secret]'
  }
  toJSON(): string {
    return '[secret]'
  }
  [inspect.custom](): string {
    return '[secret]'
  }
}

const withoutTrailingSlash = (value: string) => value.replace(/\/+$/, '')

const schema = z.object({
  SR_PUBLIC_ORIGIN: z.url({ protocol: /^https$/ }).transform(withoutTrailingSlash),
  SR_OIDC_ISSUER: z.url({ protocol: /^https?$/ }).transform(withoutTrailingSlash),
  SR_OIDC_CLIENT_ID: z.string().min(1),
  SR_OIDC_CLIENT_SECRET: z.string().min(1),
  SR_OIDC_IDP_HINT: z.string().min(1).default('microsoft'),
  SR_SESSION_KEY: z
    .base64()
    .refine((value) => Buffer.from(value, 'base64').length === 32, 'must be 32 bytes of base64'),
})

export interface Config {
  publicOrigin: string
  oidc: {
    issuer: string
    clientId: string
    clientSecret: Secret<string>
    idpHint: string
  }
  sessionKey: Secret<Buffer>
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))]
    throw new Error(`invalid configuration: ${names.join(', ')}`)
  }
  const values = parsed.data
  return {
    publicOrigin: values.SR_PUBLIC_ORIGIN,
    oidc: {
      issuer: values.SR_OIDC_ISSUER,
      clientId: values.SR_OIDC_CLIENT_ID,
      clientSecret: new Secret(values.SR_OIDC_CLIENT_SECRET),
      idpHint: values.SR_OIDC_IDP_HINT,
    },
    sessionKey: new Secret(Buffer.from(values.SR_SESSION_KEY, 'base64')),
  }
}
