/* CMP-2: BFF serving /api/v1, /auth and the SPA assets. AD-3 fixes packages/api/openapi.json, generated from the route schemas. */
export { buildApp, type AppDependencies } from './app.js'
export { loadConfig, type ApiConfig } from './config.js'
export { createServer, type ServerOptions } from './server.js'
export type { AuditEvent, AuditLog } from './audit.js'
export type { OidcClient } from './oidc.js'
export type { SessionStore, StoredSession } from './session-store.js'
