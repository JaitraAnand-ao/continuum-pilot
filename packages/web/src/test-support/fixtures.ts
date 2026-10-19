/* IF-4 responses used across the web tests; contract.test.ts proves each one is valid. */
import type { Me, Problem } from '../api/client'

export const SIGNED_IN_AT = Date.parse('2026-10-19T08:00:00Z')
const at = (minutes: number): string => new Date(SIGNED_IN_AT + minutes * 60_000).toISOString()

export const readerMe: Me = {
  account: 'm.duarte@contoso.com',
  displayName: 'Marta Duarte',
  roles: ['reader'],
  authTime: at(0),
  idleExpiresAt: at(15),
  absoluteExpiresAt: at(480),
}

export const readerAdminMe: Me = {
  ...readerMe,
  account: 'a.okafor@contoso.com',
  displayName: 'Ade Okafor',
  roles: ['reader', 'config.read', 'config.write'],
}

export const adminOnlyMe: Me = {
  ...readerMe,
  account: 'j.lind@contoso.com',
  displayName: 'Jonas Lind',
  roles: ['config.read', 'config.approve'],
}

export const noAccessProblem: Problem = {
  type: '/problems/no-access',
  title: "You don't have access. Signed in as p.ruiz@fabrikam.com.",
  status: 403,
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
}

export const unauthenticatedProblem: Problem = {
  type: '/problems/unauthenticated',
  title: 'Sign in to continue',
  status: 401,
  traceId: '0af7651916cd43dd8448eb211c80319c',
}

export function jsonResponse(status: number, body: unknown, type = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': type } })
}
