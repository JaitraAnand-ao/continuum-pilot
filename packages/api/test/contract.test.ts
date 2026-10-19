/* contracts-honoured: every documented status of IF-1 and IF-4 is produced and validated against the committed
 * contract copies in packages/api/contracts, taken verbatim from the step-7 contracts. */
import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { LightMyRequestResponse } from 'fastify'
import { afterAll, describe, expect, it } from 'vitest'
import { OUTSIDER, READER } from './support/fake-keycloak.js'
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
