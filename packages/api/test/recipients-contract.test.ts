/* contracts-honoured for IF-51 to IF-56: every status the committed contract documents is produced here and its
 * body validated against packages/api/contracts/ST-18-recipients.json; the last test proves none was left out. */
import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ADMIN_ONLY, READER } from './support/fake-keycloak.js'
import { createHarness, signIn, withSession } from './support/harness.js'

interface Operation {
  responses: Record<string, { content?: Record<string, { schema: object }> }>
}

const document = JSON.parse(readFileSync(new URL('../contracts/ST-18-recipients.json', import.meta.url), 'utf8'))
const ajv = new Ajv2020({ strict: false, allErrors: true })
addFormats.default(ajv)
ajv.addSchema({ $id: 'contract', components: document.components })
const covered = new Set<string>()

function check(path: string, method: string, response: LightMyRequestResponse, status: number) {
  expect(response.statusCode, response.body).toBe(status)
  const operation: Operation = document.paths[path][method]
  const documented = operation.responses[String(status)]
  expect(documented, `${method} ${path} documents ${status}`).toBeDefined()
  const content = documented!.content!
  const mediaType = Object.keys(content)[0]!
  expect(response.headers['content-type']).toContain(mediaType)
  const schema = JSON.parse(
    JSON.stringify(content[mediaType]!.schema).replaceAll('"#/components/', '"contract#/components/'),
  )
  expect(ajv.validate(schema, response.json()), ajv.errorsText()).toBe(true)
  covered.add(`${method} ${path} ${status}`)
}

const h = createHarness('2026-10-20T10:00:00.000Z')
let admin: string | undefined
let reader: string | undefined

beforeAll(async () => {
  h.directory.person('u-dchen', 'd.chen').person('u-mvance', 'm.vance').person('u-x', 'x')
  h.directory.group('g-mixed', 'mixed', 'mixed@contoso.com', ['u-dchen', 'u-mvance'])
  h.directory.group('g-empty', 'nobody', 'nobody@contoso.com', [])
  h.directory.addToReaders('u-dchen', 'u-x')
  admin = (await signIn(h, ADMIN_ONLY)).session
  reader = (await signIn(h, READER)).session
}, 60_000)

afterAll(async () => {
  await h.app.close()
})

const as = (session: string | undefined) => ({ cookies: withSession(session) })

function denials(path: string, method: string, url: string) {
  it('401 and 403 match the contract', async () => {
    const verb = method.toUpperCase() as 'GET' | 'POST' | 'DELETE'
    const payload = verb === 'POST' ? { directoryId: 'u-dchen' } : undefined
    check(path, method, await h.app.inject({ method: verb, url, payload }), 401)
    check(path, method, await h.app.inject({ method: verb, url, payload, ...as(reader) }), 403)
  })
}

describe('IF-51 GET /api/v1/recipients', () => {
  const path = '/api/v1/recipients'
  it('200 (empty and listed) and 503 match the contract', async () => {
    check(path, 'get', await h.app.inject({ url: path, ...as(admin) }), 200)
    await h.recipients.add({
      id: 'r-soc',
      directoryId: 'g-soc',
      kind: 'group',
      displayName: 'SOC team',
      address: 'soc@contoso.com',
      memberCount: 5,
      status: 'active',
      addedBy: 'a@contoso.com',
      addedAt: '2026-10-01T09:00:00.000Z',
    })
    check(path, 'get', await h.app.inject({ url: path, ...as(admin) }), 200)
    h.recipients.rejectReads = true
    check(path, 'get', await h.app.inject({ url: path, ...as(admin) }), 503)
    h.recipients.rejectReads = false
  })
  denials(path, 'get', path)
})

describe('IF-52 GET /api/v1/recipients/directory', () => {
  const path = '/api/v1/recipients/directory'
  it('200, 400 and 503 match the contract', async () => {
    check(path, 'get', await h.app.inject({ url: `${path}?q=chen`, ...as(admin) }), 200)
    check(path, 'get', await h.app.inject({ url: `${path}?q=%24filter`, ...as(admin) }), 400)
    h.directory.failing = true
    check(path, 'get', await h.app.inject({ url: `${path}?q=chen`, ...as(admin) }), 503)
    h.directory.failing = false
  })
  denials(path, 'get', `${path}?q=chen`)
})

describe('IF-53 POST /api/v1/recipients', () => {
  const path = '/api/v1/recipients'
  const post = (payload: object) => h.app.inject({ method: 'POST', url: path, payload, ...as(admin) })
  it('201, 400, 404, 409, 422 and 503 match the contract', async () => {
    check(path, 'post', await post({ directoryId: 'u-dchen' }), 201)
    check(path, 'post', await post({ directoryId: 'u-dchen', extra: 1 }), 400)
    check(path, 'post', await post({ directoryId: 'u-ghost' }), 404)
    check(path, 'post', await post({ directoryId: 'u-dchen' }), 409)
    check(path, 'post', await post({ directoryId: 'u-mvance' }), 422)
    check(path, 'post', await post({ directoryId: 'g-mixed' }), 422)
    check(path, 'post', await post({ directoryId: 'g-empty' }), 422)
    h.recipients.rejectWrites = true
    check(path, 'post', await post({ directoryId: 'u-x' }), 503)
    h.recipients.rejectWrites = false
    h.directory.failing = true
    check(path, 'post', await post({ directoryId: 'u-x' }), 503)
    h.directory.failing = false
  })
  denials(path, 'post', path)
})

for (const [iface, path, url, wrongStatusId, rightStatusId] of [
  ['IF-54', '/api/v1/recipients/{id}', (id: string) => `/api/v1/recipients/${id}`, 'pending', 'active'],
  [
    'IF-55',
    '/api/v1/recipients/{id}/proposal',
    (id: string) => `/api/v1/recipients/${id}/proposal`,
    'active',
    'pending',
  ],
] as const) {
  describe(`${iface} DELETE ${path}`, () => {
    const del = (id: string) => h.app.inject({ method: 'DELETE', url: url(id), ...as(admin) })
    const seed = async (id: string, status: 'active' | 'pending') =>
      h.recipients.add({
        id,
        directoryId: `d-${id}`,
        kind: 'person',
        displayName: id,
        address: `${id}@contoso.com`,
        memberCount: null,
        status,
        addedBy: 'a@contoso.com',
        addedAt: '2026-10-01T09:00:00.000Z',
      })
    it('200, 400, 404, 409 and 503 match the contract', async () => {
      await seed(`${iface}-a`, rightStatusId)
      await seed(`${iface}-b`, wrongStatusId)
      await seed(`${iface}-c`, rightStatusId)
      check(path, 'delete', await del(`${iface}-a`), 200)
      check(path, 'delete', await del('bad%20id'), 400)
      check(path, 'delete', await del('r-ghost'), 404)
      check(path, 'delete', await del(`${iface}-b`), 409)
      h.recipients.rejectWrites = true
      check(path, 'delete', await del(`${iface}-c`), 503)
      h.recipients.rejectWrites = false
    })
    denials(path, 'delete', url('r-any'))
  })
}

describe('IF-56 GET /api/v1/recipients/audit', () => {
  const path = '/api/v1/recipients/audit'
  it('200 and 503 match the contract', async () => {
    check(path, 'get', await h.app.inject({ url: path, ...as(admin) }), 200)
    const trail = h.audit.recipientEvents
    h.audit.recipientEvents = async () => {
      throw new Error('audit store down')
    }
    check(path, 'get', await h.app.inject({ url: path, ...as(admin) }), 503)
    h.audit.recipientEvents = trail
  })
  denials(path, 'get', path)
})

describe('the contract', () => {
  it('has every documented status exercised above', () => {
    const documented: string[] = []
    for (const [path, methods] of Object.entries(document.paths as Record<string, Record<string, Operation>>)) {
      for (const [method, operation] of Object.entries(methods)) {
        for (const status of Object.keys(operation.responses)) documented.push(`${method} ${path} ${status}`)
      }
    }
    expect(documented.filter((one) => !covered.has(one))).toEqual([])
  })
})
