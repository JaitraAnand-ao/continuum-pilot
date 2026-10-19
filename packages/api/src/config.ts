/* The BFF's settings, read only from the environment through this schema (SR_ prefix). */
import { z } from 'zod'
import { Secret } from './secret.js'

const sessionKey = z
  .string()
  .min(1)
  .transform((value, context) => {
    const key = Buffer.from(value, 'base64')
    if (key.length !== 32) {
      context.addIssue({ code: 'custom', message: 'SR_SESSION_KEY must be 32 bytes, base64-encoded (AES-256-GCM)' })
      return z.NEVER
    }
    return new Secret(key)
  })

const schema = z.object({
  SR_PUBLIC_ORIGIN: z.url({ protocol: /^https?$/ }).transform((value) => new URL(value).origin),
  SR_OIDC_ISSUER: z.url({ protocol: /^https?$/ }).transform((value) => value.replace(/\/+$/, '')),
  SR_OIDC_CLIENT_ID: z.string().min(1),
  SR_OIDC_CLIENT_SECRET: z
    .string()
    .min(1)
    .transform((value) => new Secret(value)),
  SR_OIDC_IDP_HINT: z.string().min(1).default('microsoft'),
  SR_SESSION_KEY: sessionKey,
})

export interface ApiConfig {
  publicOrigin: string
  redirectUri: string
  oidc: {
    issuer: string
    clientId: string
    clientSecret: Secret
    idpHint: string
  }
  sessionKey: Secret<Buffer>
}

export function loadConfig(env: Record<string, string | undefined>): ApiConfig {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))].join(', ')
    throw new Error(`invalid API configuration: ${fields}`)
  }
  const value = parsed.data
  return {
    publicOrigin: value.SR_PUBLIC_ORIGIN,
    redirectUri: `${value.SR_PUBLIC_ORIGIN}/auth/callback`,
    oidc: {
      issuer: value.SR_OIDC_ISSUER,
      clientId: value.SR_OIDC_CLIENT_ID,
      clientSecret: value.SR_OIDC_CLIENT_SECRET,
      idpHint: value.SR_OIDC_IDP_HINT,
    },
    sessionKey: value.SR_SESSION_KEY,
  }
}
