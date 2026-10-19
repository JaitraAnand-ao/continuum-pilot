/* AD-19, the one routing table both the ALB and the local edge nginx must follow:
 * the signin-reports realm and Keycloak's static resources go to Keycloak, everything
 * else to the api, and nothing reaches the admin console or the master realm. */
export type Destination = 'api' | 'keycloak' | 'denied'

export interface Case {
  /** The request target as the client sent it. */
  raw: string
  /** What nginx matches locations against after decoding and merging/resolving the path. */
  normalised?: string
  expected: Destination
}

export const routingCases: Case[] = [
  { raw: '/', expected: 'api' },
  { raw: '/reports/daily/2026-10-18', expected: 'api' },
  { raw: '/api/reports/daily/2026-10-18', expected: 'api' },
  { raw: '/api/auth/callback', expected: 'api' },
  { raw: '/realms/signin-reports/protocol/openid-connect/auth', expected: 'keycloak' },
  { raw: '/realms/signin-reports/protocol/openid-connect/token', expected: 'keycloak' },
  {
    raw: '/realms/signin-reports/protocol/openid-connect/auth?client_id=signin-reports-api&redirect_uri=https%3A%2F%2Flocalhost%2Fapi%2Fauth%2Fcallback',
    normalised: '/realms/signin-reports/protocol/openid-connect/auth',
    expected: 'keycloak',
  },
  { raw: '/realms/signin-reports/.well-known/openid-configuration', expected: 'keycloak' },
  { raw: '/realms/signin-reports/broker/entra/endpoint', expected: 'keycloak' },
  { raw: '/resources/x1y2z/login/keycloak.v2/css/styles.css', expected: 'keycloak' },
  // Another realm name is not Keycloak's to answer; it falls through to the api.
  { raw: '/realms/signin-reports-other/protocol/openid-connect/auth', expected: 'api' },
  { raw: '/admin', expected: 'denied' },
  { raw: '/admin/', expected: 'denied' },
  { raw: '/admin/master/console/', expected: 'denied' },
  { raw: '/admin/realms/signin-reports/users', expected: 'denied' },
  { raw: '/realms/master', expected: 'denied' },
  { raw: '/realms/master/protocol/openid-connect/token', expected: 'denied' },
  { raw: '/resources/x1y2z/admin/keycloak.v2/main.js', expected: 'denied' },
  {
    raw: '/realms/signin-reports/../master/protocol/openid-connect/token',
    normalised: '/realms/master/protocol/openid-connect/token',
    expected: 'denied',
  },
  { raw: '/realms/signin-reports/%2e%2e/master/', normalised: '/realms/master/', expected: 'denied' },
  { raw: '/realms/signin-reports/%2E%2E/master/', normalised: '/realms/master/', expected: 'denied' },
  { raw: '/realms/signin-reports%2F..%2Fmaster', normalised: '/realms/master', expected: 'denied' },
  {
    raw: '/resources/x1y2z/%61dmin/keycloak.v2/main.js',
    normalised: '/resources/x1y2z/admin/keycloak.v2/main.js',
    expected: 'denied',
  },
]
