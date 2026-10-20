/* contracts-honoured: every documented status of IF-1, IF-4 and IF-27 is produced and validated against the committed
 * contract copies in packages/api/contracts, taken verbatim from the step-7 contracts. */
import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { LightMyRequestResponse } from 'fastify'
import { afterAll, describe, expect, it } from 'vitest'
import { ADMIN_ONLY, OUTSIDER, READER } from './support/fake-keycloak.js'
import { createHarness, signIn, startLogin, withSession } from './support/harness.js'

interface Operation {
  responses: Record<
    string,
    {
      headers?: Record<string, { schema: object }>
      content?: Record<string, { schema: object }>
    }
  >
}

function load(name: string) {
  const document = JSON.parse(readFileSync(new URL(`../contracts/${name}.json`, import.meta.url), 'utf8'))
  const ajv = new Ajv2020({ strict: false, allErrors: true })
  addFormats.default(ajv)
  ajv.addSchema({ $id: 'contract', components: document.components })
  return { document, ajv }
}

function rewrite(schema: object): object {
  return JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"contract#/components/'))
}

function check(name: string, path: string, method: string, response: LightMyRequestResponse) {
  const { document, ajv } = load(name)
  const operation: Operation = document.paths[path][method]
  const documented = operation.responses[String(response.statusCode)]
  expect(documented, `${name} documents ${response.statusCode}`).toBeDefined()
  for (const [header, { schema }] of Object.entries(documented!.headers ?? {})) {
    const value = response.headers[header.toLowerCase()]
    const values = Array.isArray(value) ? value : [value]
    for (const one of values) {
      const valid = ajv.validate(rewrite(schema), one)
      expect(valid, `${header}: ${ajv.errorsText()}`).toBe(true)
    }
  }
  const content = documented!.content
  if (content) {
    const mediaType = Object.keys(content)[0]!
    expect(response.headers['content-type']).toContain(mediaType)
    const valid = ajv.validate(rewrite(content[mediaType]!.schema), response.json())
    expect(valid, ajv.errorsText()).toBe(true)
  }
}

const h = createHarness()
afterAll(async () => {
  await h.app.close()
})

describe('IF-1 GET /auth/login', () => {
  it('302 matches the contract', async () => {
    check('IF-1', '/auth/login', 'get', (await startLogin(h, '?returnTo=%2F&maxAge=0')).response)
  })

  it('400 matches the contract', async () => {
    check('IF-1', '/auth/login', 'get', (await startLogin(h, '?returnTo=%2F%2Fevil')).response)
  })

  it('503 matches the contract', async () => {
    const down = createHarness()
    down.keycloak.state.discoveryDown = true
    check('IF-1', '/auth/login', 'get', (await startLogin(down)).response)
    await down.app.close()
  })
})

describe('IF-4 GET /api/v1/me', () => {
  it('200 matches the contract', async () => {
    const { session } = await signIn(h, READER)
    check('IF-4', '/api/v1/me', 'get', await h.app.inject({ url: '/api/v1/me', cookies: withSession(session) }))
  })

  it('401 matches the contract', async () => {
    check('IF-4', '/api/v1/me', 'get', await h.app.inject({ url: '/api/v1/me' }))
  })

  it('403 matches the NoAccessProblem contract', async () => {
    const { session } = await signIn(h, OUTSIDER)
    check('IF-4', '/api/v1/me', 'get', await h.app.inject({ url: '/api/v1/me', cookies: withSession(session) }))
  })
})

describe('IF-27 GET /api/v1/report-history', () => {
  const path = '/api/v1/report-history'

  it('200 matches the contract, with stored, late and not-generated days', async () => {
    h.reports.reports = [
      { reportDate: '2026-10-17', publishedAt: '2026-10-18T02:03:04.567Z', total: 1500, failed: 12 },
      { reportDate: '2026-10-16', publishedAt: '2026-10-17T07:42:00.000Z', total: 0, failed: 0 },
    ]
    h.reports.notGenerated = ['2026-10-15']
    const { session } = await signIn(h, READER)
    const response = await h.app.inject({ url: path, cookies: withSession(session) })
    expect(response.json().items.length).toBeGreaterThan(0)
    check('IF-27', path, 'get', response)
    h.reports.reports = []
    h.reports.notGenerated = []
  })

  it('200 matches the contract before the first report', async () => {
    const fresh = createHarness()
    fresh.reports.startedAt = new Date('2026-10-19T07:00:00.000Z')
    const { session } = await signIn(fresh, READER)
    const response = await fresh.app.inject({ url: path, cookies: withSession(session) })
    expect(response.json().firstReportDueAt).toBe('2026-10-21T08:00:00.000Z')
    check('IF-27', path, 'get', response)
    await fresh.app.close()
  })

  it('400 matches the contract', async () => {
    const { session } = await signIn(h, READER)
    check('IF-27', path, 'get', await h.app.inject({ url: `${path}?month=2026-13`, cookies: withSession(session) }))
  })

  it('401 matches the contract', async () => {
    check('IF-27', path, 'get', await h.app.inject({ url: path }))
  })

  it('403 matches the contract', async () => {
    const { session } = await signIn(h, ADMIN_ONLY)
    check('IF-27', path, 'get', await h.app.inject({ url: path, cookies: withSession(session) }))
  })

  it('503 matches the contract', async () => {
    const down = createHarness()
    down.reports.failure = new Error('timeout')
    const { session } = await signIn(down, READER)
    check('IF-27', path, 'get', await down.app.inject({ url: path, cookies: withSession(session) }))
    await down.app.close()
  })
})
