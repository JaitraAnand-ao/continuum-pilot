import { describe, expect, it } from 'vitest'
import { findTemporaryAdmins, main } from '../scripts/check-bootstrap-admin.mjs'

/* The post-deploy check fails the deployment while the temporary bootstrap admin (user or
 * service client) still exists in the master realm. It talks to the admin API only over the
 * internal network and with the permanent operator token; here the API is a fake. */

type Answer = { status?: number; body: unknown }

function fakeApi(answers: Record<string, Answer>) {
  const calls: { url: string; authorization: string | null }[] = []
  const fetch = async (url: string | URL, init?: RequestInit) => {
    const href = String(url)
    calls.push({ url: href, authorization: new Headers(init?.headers).get('authorization') })
    const path = new URL(href).pathname + new URL(href).search
    const answer = answers[path]
    if (!answer) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 })
  }
  return { fetch, calls }
}

const users = '/admin/realms/master/users?q=is_temporary_admin%3Atrue&briefRepresentation=true'
const clients = '/admin/realms/master/clients?q=is_temporary_admin%3Atrue'

describe('findTemporaryAdmins', () => {
  it('finds nothing once the bootstrap admin is gone', async () => {
    const api = fakeApi({ [users]: { body: [] }, [clients]: { body: [] } })
    const found = await findTemporaryAdmins({ baseUrl: 'https://kc.internal:8443/', token: 't0k', fetch: api.fetch })
    expect(found).toEqual([])
    expect(api.calls.map((call) => call.authorization)).toEqual(['Bearer t0k', 'Bearer t0k'])
  })

  it('names a remaining temporary admin user and service client', async () => {
    const api = fakeApi({
      [users]: { body: [{ id: 'u1', username: 'temp-admin' }] },
      [clients]: { body: [{ id: 'c1', clientId: 'temp-admin-client' }] },
    })
    const found = await findTemporaryAdmins({ baseUrl: 'https://kc.internal:8443', token: 't', fetch: api.fetch })
    expect(found).toEqual(['user temp-admin', 'client temp-admin-client'])
  })

  it('fails closed when the admin API refuses the query', async () => {
    const api = fakeApi({ [users]: { status: 403, body: {} }, [clients]: { body: [] } })
    await expect(
      findTemporaryAdmins({ baseUrl: 'https://kc.internal:8443', token: 't', fetch: api.fetch }),
    ).rejects.toThrow(/403/)
  })
})

describe('main', () => {
  const env = { SR_KEYCLOAK_ADMIN_URL: 'https://kc.internal:8443', SR_KEYCLOAK_ADMIN_TOKEN: 't' }

  it('exits 0 and says so when no bootstrap admin remains', async () => {
    const out: string[] = []
    const api = fakeApi({ [users]: { body: [] }, [clients]: { body: [] } })
    const code = await main({ env, fetch: api.fetch, log: (line: string) => out.push(line) })
    expect(code).toBe(0)
    expect(out.join('\n')).toMatch(/no temporary bootstrap admin/)
  })

  it('exits 1, failing the deployment, while a bootstrap admin remains', async () => {
    const out: string[] = []
    const api = fakeApi({ [users]: { body: [{ username: 'temp-admin' }] }, [clients]: { body: [] } })
    const code = await main({ env, fetch: api.fetch, log: (line: string) => out.push(line) })
    expect(code).toBe(1)
    expect(out.join('\n')).toContain('user temp-admin')
  })

  it('exits 1 when the API cannot be queried', async () => {
    const out: string[] = []
    const api = fakeApi({})
    expect(await main({ env, fetch: api.fetch, log: (line: string) => out.push(line) })).toBe(1)
    expect(out.join('\n')).toMatch(/404/)
  })

  it('exits 2 when it is not told where or how to look', async () => {
    const out: string[] = []
    const api = fakeApi({})
    expect(await main({ env: {}, fetch: api.fetch, log: (line: string) => out.push(line) })).toBe(2)
    expect(out.join('\n')).toContain('SR_KEYCLOAK_ADMIN_URL')
    expect(api.calls).toEqual([])
  })
})
