/* CMP-2: BFF serving /api/v1, /auth and the SPA assets. AD-3 fixes packages/api/openapi.json, generated from the route schemas. */
import { buildApp, type AppDependencies } from './app.js'
import { KeycloakOidcClient } from './auth/oidc.js'
import { systemClock } from './clock.js'
import { loadConfig } from './config.js'
import type { AuditSink } from './audit.js'
import type { SessionStore } from './session/store.js'

export { authenticate, buildApp, requireReader, type AppDependencies } from './app.js'
export { loadConfig, type ApiConfig } from './config.js'
export { KeycloakOidcClient, type OidcClient } from './auth/oidc.js'
export { InMemorySessionStore, type SessionRecord, type SessionStore } from './session/store.js'
export { InMemoryAuditSink, type AuditEvent, type AuditSink } from './audit.js'
export { Secret } from './secret.js'
export type { Clock } from './clock.js'

/* Wires the BFF from the environment; the stores are the adapters CMP-5 provides. */
export function createServer(
  env: Record<string, string | undefined>,
  ports: { sessions: SessionStore; audit: AuditSink } & Partial<Pick<AppDependencies, 'clock'>>,
) {
  const config = loadConfig(env)
  const oidc = new KeycloakOidcClient({ ...config.oidc, redirectUri: config.redirectUri })
  return buildApp({ ...ports, oidc, clock: ports.clock ?? systemClock, sessionKey: config.sessionKey })
}
