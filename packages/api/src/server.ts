/* Composes the API from its configuration: the Keycloak adapter and the in-process stores. */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { buildApp } from './app.js'
import { InMemoryAuditLog } from './audit.js'
import { systemClock, type Clock } from './clock.js'
import type { ApiConfig } from './config.js'
import { createKeycloakClient } from './keycloak-client.js'
import { InMemorySessionStore } from './session-store.js'

export interface ServerOptions {
  fetch?: typeof globalThis.fetch
  clock?: Clock
  reportRoutes?: FastifyPluginAsync
}

export function createServer(config: ApiConfig, options: ServerOptions = {}): FastifyInstance {
  const clock = options.clock ?? systemClock
  return buildApp({
    publicOrigin: config.publicOrigin,
    sealingKey: Buffer.from(config.sessionEncryptionKey.reveal(), 'base64'),
    oidc: createKeycloakClient({
      issuer: config.oidcIssuer,
      clientId: config.oidcClientId,
      clientSecret: config.oidcClientSecret,
      clock,
      fetch: options.fetch ?? globalThis.fetch,
    }),
    sessions: new InMemorySessionStore(),
    audit: new InMemoryAuditLog(),
    clock,
    ...(options.reportRoutes === undefined ? {} : { reportRoutes: options.reportRoutes }),
    /* No-PII logging: cookies and Set-Cookie never reach a log line. */
    logger: { redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'] },
  })
}
