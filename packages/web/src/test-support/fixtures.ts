/* Test support: IF-4 responses, each one validated against the pinned contract in
 * api/client.test.ts. Times are fixed so idle and absolute limits are deterministic. */
import type { Me } from '../api/client'

export const SIGNED_IN_AT = Date.parse('2026-10-19T08:00:00Z')
const minutes = (count: number) => new Date(SIGNED_IN_AT + count * 60_000).toISOString()

export const readerMe: Me = {
  account: 'm.duarte@contoso.com',
  displayName: 'Marta Duarte',
  roles: ['reader'],
  authTime: minutes(0),
  idleExpiresAt: minutes(15),
  absoluteExpiresAt: minutes(8 * 60),
}

export const readerAdminMe: Me = {
  ...readerMe,
  account: 'a.okafor@contoso.com',
  displayName: 'Ada Okafor',
  roles: ['reader', 'config.read', 'config.write'],
}

export const adminOnlyMe: Me = {
  ...readerMe,
  account: 'j.lin@contoso.com',
  displayName: 'Jun Lin',
  roles: ['config.read', 'config.approve'],
}

export const noSessionProblem = {
  type: '/problems/unauthenticated',
  title: 'Sign-in required',
  status: 401,
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
}

export const noAccessProblem = {
  type: '/problems/no-access',
  title: "You don't have access. Signed in as p.ruiz@fabrikam.com.",
  status: 403,
  traceId: '0af7651916cd43dd8448eb211c80319c',
}

/** A fetch double answering each request from the queue, recording what was asked. */
export function fakeFetch(...responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init })
    const next = responses.shift()
    if (!next) throw new Error(`unexpected request to ${url}`)
    if (next instanceof Error) throw next
    return next
  }
  return { fetch, calls }
}

export const json = (status: number, body: unknown, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } })

export const problem = (body: { status: number; [field: string]: unknown }) =>
  json(body.status, body, 'application/problem+json')
