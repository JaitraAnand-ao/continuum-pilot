/* The API's Zod config module: every setting is SR_-prefixed and environment-only; secrets are wrapped in Secret. */
import { z } from 'zod'
import { Secret } from './secret.js'

const secret = z
  .string()
  .min(1)
  .transform((value) => new Secret(value))

const schema = z.object({
  SR_PUBLIC_ORIGIN: z.url({ protocol: /^https$/ }).transform((value) => new URL(value).origin),
  SR_OIDC_ISSUER: z.url({ protocol: /^https?$/ }).transform((value) => value.replace(/\/+$/, '')),
  SR_OIDC_CLIENT_ID: z.string().min(1),
  SR_OIDC_CLIENT_SECRET: secret,
  /* AD-5: base64 of the 32-byte AES-256-GCM key sealing refresh tokens and the login transaction. */
  SR_SESSION_ENCRYPTION_KEY: z
    .string()
    .refine((value) => Buffer.from(value, 'base64').length === 32, 'must be base64 of exactly 32 bytes')
    .transform((value) => new Secret(value)),
  SR_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
})

export interface ApiConfig {
  publicOrigin: string
  oidcIssuer: string
  oidcClientId: string
  oidcClientSecret: Secret
  sessionEncryptionKey: Secret
  port: number
}

export function loadConfig(env: Record<string, string | undefined>): ApiConfig {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    /* Name the settings only; a value may be a secret. */
    const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))].join(', ')
    throw new Error(`invalid API configuration: ${names}`)
  }
  const value = parsed.data
  return {
    publicOrigin: value.SR_PUBLIC_ORIGIN,
    oidcIssuer: value.SR_OIDC_ISSUER,
    oidcClientId: value.SR_OIDC_CLIENT_ID,
    oidcClientSecret: value.SR_OIDC_CLIENT_SECRET,
    sessionEncryptionKey: value.SR_SESSION_ENCRYPTION_KEY,
    port: value.SR_PORT,
  }
}
