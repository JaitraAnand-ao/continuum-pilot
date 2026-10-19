/* CMP-2: BFF serving /api/v1, /auth and the SPA assets. AD-3 fixes packages/api/openapi.json, generated from the route schemas. */
export { buildApp, type AppDeps } from './app.js'
export { decideAccess, rolesFromClaims, ROLES, type Role, type RouteAccess } from './access.js'
export { InMemoryAuditSink, type AuditEvent, type AuditSink } from './audit.js'
export { systemClock, type Clock } from './clock.js'
export { loadConfig, Secret, type ApiConfig } from './config.js'
export { createOidcClient, type OidcClient } from './oidc/client.js'
export { InMemorySessionStore, type SessionStore, type StoredSession } from './session/store.js'
