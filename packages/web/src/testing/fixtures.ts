/* Payloads shaped exactly as contracts/IF-4.json answers; contract.test.ts validates each one. */
import type { Me, Problem, Role } from '../api/client'

export const NOW = Date.parse('2026-10-19T08:00:00.000Z')
export const MINUTE = 60 * 1000

export function me(roles: Role[], overrides: Partial<Me> = {}): Me {
  return {
    account: 'm.duarte@contoso.com',
    displayName: 'Marta Duarte',
    roles,
    authTime: new Date(NOW).toISOString(),
    idleExpiresAt: new Date(NOW + 15 * MINUTE).toISOString(),
    absoluteExpiresAt: new Date(NOW + 8 * 60 * MINUTE).toISOString(),
    ...overrides,
  }
}

export const READER = me(['reader'])
export const READER_AND_ADMIN = me(['reader', 'config.read', 'config.write'])
export const ADMIN_ONLY = me(['config.read'])

export const NO_ACCESS: Problem = {
  type: '/problems/no-access',
  title: "You don't have access. Signed in as j.smith@contoso.com.",
  status: 403,
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
}

export const UNAUTHENTICATED: Problem = {
  type: '/problems/unauthenticated',
  title: 'Sign in to continue.',
  status: 401,
  traceId: '0af7651916cd43dd8448eb211c80319c',
}

export const SERVER_ERROR: Problem = {
  type: '/problems/unavailable',
  title: 'Service unavailable.',
  status: 503,
  traceId: 'a3ce929d0e0e47364bf92f3577b34da6',
}

export function json(status: number, body: unknown, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } })
}

export const problem = (body: Problem): Response => json(body.status, body, 'application/problem+json')
