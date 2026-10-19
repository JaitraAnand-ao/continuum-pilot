import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ADMIN_ONLY, createHarness, OUTSIDER, READER, type Harness } from './test-support/harness.js'

/* A stand-in for the report routes later stories add: they declare access 'reader' and nothing else. */
let h: Harness
let handlerCalls = 0
beforeEach(async () => {
  handlerCalls = 0
  h = await createHarness({
    routes: (app) => {
      app.get('/api/v1/reports/daily/:date', { config: { access: 'reader' } }, async () => {
        handlerCalls += 1
        return { figures: { signIns: 42 } }
      })
      app.get('/api/v1/undeclared', async () => ({ leaked: true }))
    },
  })
})
afterEach(async () => {
  await h.close()
})

const daily = (cookie?: string) =>
  h.app.inject({
    method: 'GET',
    url: '/api/v1/reports/daily/2026-10-18',
    headers: cookie === undefined ? {} : { cookie: `__Host-sr_session=${cookie}` },
  })

function expectBareProblem(body: Record<string, unknown>) {
  expect(Object.keys(body).sort()).toEqual(['status', 'title', 'traceId', 'type'])
  expect(body.traceId).toMatch(/^[0-9a-f]{32}$/)
}

describe('AC-7 report endpoints refuse requests without the reader role', () => {
  it('answers 401 problem+json with no session, before the route runs', async () => {
    const response = await daily()
    expect(response.statusCode).toBe(401)
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/)
    expectBareProblem(response.json())
    expect(handlerCalls).toBe(0)
  })

  it('answers 403 problem+json with only type, title, status and traceId to an administrator', async () => {
    const response = await daily(await h.signIn(ADMIN_ONLY))
    expect(response.statusCode).toBe(403)
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/)
    expectBareProblem(response.json())
    expect(response.json()).toMatchObject({ type: '/problems/forbidden', status: 403 })
    expect(handlerCalls).toBe(0)
    expect(h.audit.events.at(-1)).toMatchObject({
      type: 'access-denied',
      account: ADMIN_ONLY.upn,
      route: '/api/v1/reports/daily/:date',
    })
  })

  it('AC-5: a denied account opening the Daily report address gets 403 and no figures, and is audited', async () => {
    const cookie = await h.signIn(OUTSIDER)
    const response = await daily(cookie)
    expect(response.statusCode).toBe(403)
    expectBareProblem(response.json())
    expect(response.body).not.toContain('figures')
    expect(handlerCalls).toBe(0)
    expect(h.audit.events.filter((event) => event.route === '/api/v1/reports/daily/:date')).toHaveLength(1)
  })

  it('lets a reader through', async () => {
    const response = await daily(await h.signIn(READER))
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ figures: { signIns: 42 } })
  })

  it('fails closed: a route that declares no access needs the reader role', async () => {
    const anonymous = await h.app.inject({ method: 'GET', url: '/api/v1/undeclared' })
    expect(anonymous.statusCode).toBe(401)
    const admin = await h.app.inject({
      method: 'GET',
      url: '/api/v1/undeclared',
      headers: { cookie: `__Host-sr_session=${await h.signIn(ADMIN_ONLY)}` },
    })
    expect(admin.statusCode).toBe(403)
  })

  it('fails closed on unknown addresses too, and answers 404 problem+json to a reader', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/reports/weekly' })).statusCode).toBe(401)
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/v1/reports/weekly',
      headers: { cookie: `__Host-sr_session=${await h.signIn(READER)}` },
    })
    expect(response.statusCode).toBe(404)
    expectBareProblem(response.json())
  })

  it('answers 500 problem+json without leaking the cause', async () => {
    const failing = await createHarness({
      routes: (app) => {
        app.get('/api/v1/boom', { config: { access: 'public' } }, async () => {
          throw new Error('relation "secret_table" does not exist')
        })
      },
    })
    const response = await failing.app.inject({ method: 'GET', url: '/api/v1/boom' })
    await failing.close()
    expect(response.statusCode).toBe(500)
    expectBareProblem(response.json())
    expect(response.body).not.toContain('secret_table')
  })
})
