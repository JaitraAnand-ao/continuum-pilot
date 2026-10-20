/* AD-19 as a request table: every path the edge must route, and where it must land.
 * Both the production ALB (terraform/) and the local nginx (nginx/edge.conf) are
 * checked against this one table, so the two can never drift apart. */
export type Destination = 'api' | 'keycloak' | 'deny'

export const AD19_ROUTES: ReadonlyArray<{ path: string; to: Destination; why: string }> = [
  { path: '/', to: 'api', why: 'the SPA is served by the api (AD-3)' },
  { path: '/signin', to: 'api', why: 'SCR-1 Sign in screen' },
  { path: '/auth/callback?code=x&state=y', to: 'api', why: 'BFF OIDC callback' },
  { path: '/api/reports/daily/2026-10-18', to: 'api', why: 'report endpoints (AC-7)' },
  { path: '/api/session', to: 'api', why: 'session endpoint (AC-8, AC-9)' },
  {
    path: '/realms/signin-reports/protocol/openid-connect/auth?client_id=web',
    to: 'keycloak',
    why: 'authorization endpoint of the application realm',
  },
  {
    path: '/realms/signin-reports/protocol/openid-connect/logout',
    to: 'keycloak',
    why: 'end-session endpoint (AC-9 sign out)',
  },
  {
    path: '/realms/signin-reports/broker/entra/endpoint?code=x',
    to: 'keycloak',
    why: 'Entra identity-provider broker callback',
  },
  {
    path: '/realms/signin-reports/.well-known/openid-configuration',
    to: 'keycloak',
    why: 'discovery document',
  },
  {
    path: '/resources/abc12/login/keycloak.v2/css/styles.css',
    to: 'keycloak',
    why: 'login theme assets',
  },
  { path: '/admin', to: 'deny', why: 'Keycloak admin console' },
  { path: '/admin/', to: 'deny', why: 'Keycloak admin console' },
  { path: '/admin/master/console/', to: 'deny', why: 'Keycloak admin console' },
  { path: '/admin/realms/signin-reports/users', to: 'deny', why: 'Keycloak admin REST API' },
  { path: '/realms/master', to: 'deny', why: 'master realm' },
  {
    path: '/realms/master/protocol/openid-connect/token',
    to: 'deny',
    why: 'master realm token endpoint',
  },
  {
    path: '/realms/fake-entra/protocol/openid-connect/auth',
    to: 'deny',
    why: 'any realm other than signin-reports',
  },
  { path: '/realms/signin-reports', to: 'deny', why: 'bare realm path is not an endpoint' },
  {
    path: '/realms/signin-reports/../master/protocol/openid-connect/token',
    to: 'deny',
    why: 'dot-segment traversal into the master realm',
  },
  {
    path: '/realms/signin-reports/%2e%2e/master/',
    to: 'deny',
    why: 'encoded dot-segment traversal',
  },
  { path: '/resources/..%2fadmin/master/console/', to: 'deny', why: 'encoded slash traversal' },
  { path: '/resources/%2E%2E/admin/', to: 'deny', why: 'upper-case encoded traversal' },
]

/** The Keycloak paths no request may ever reach through the edge. */
export const ADMIN_PATHS = AD19_ROUTES.filter((r) => /admin|master/.test(r.path)).map((r) => r.path)
