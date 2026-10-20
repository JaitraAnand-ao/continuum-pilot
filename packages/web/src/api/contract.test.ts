/* The fixtures every test answers with are the contract's shapes, not a guess at the server's code. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Ajv2020Module from 'ajv/dist/2020.js'
import addFormatsModule from 'ajv-formats'
import { describe, expect, it } from 'vitest'
import {
  ADMIN_ONLY,
  json,
  me,
  NO_ACCESS,
  problem,
  READER,
  READER_AND_ADMIN,
  SERVER_ERROR,
  UNAUTHENTICATED,
} from '../testing/fixtures'
import { BAD_REQUEST, HISTORY, NO_REPORTS_YET, NOT_A_READER } from '../testing/history'
import { createApi } from './client'

const contract = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../contracts/${name}.json`, import.meta.url)), 'utf8'))

type AjvInstance = import('ajv/dist/2020.js').default
const Ajv2020 = ((Ajv2020Module as unknown as { default?: unknown }).default ?? Ajv2020Module) as new (
  options: object,
) => AjvInstance
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (
  ajv: AjvInstance,
) => void

function validatorFor(name: string, path: string, status: string, mediaType: string) {
  const document = contract(name)
  const ajv = new Ajv2020({ strict: false, allErrors: true })
  addFormats(ajv)
  ajv.addSchema({ $id: 'contract', components: document.components }, 'contract')
  const schema = JSON.parse(
    JSON.stringify(document.paths[path].get.responses[status].content[mediaType].schema).replaceAll(
      '"#/components',
      '"contract#/components',
    ),
  )
  return ajv.compile(schema)
}

describe('IF-4 GET /api/v1/me fixtures', () => {
  const ok = validatorFor('IF-4', '/api/v1/me', '200', 'application/json')
  const unauthenticated = validatorFor('IF-4', '/api/v1/me', '401', 'application/problem+json')
  const denied = validatorFor('IF-4', '/api/v1/me', '403', 'application/problem+json')

  it.each([
    ['reader', READER],
    ['reader and administrator', READER_AND_ADMIN],
    ['administrator only', ADMIN_ONLY],
    ['no roles', me([])],
  ])('the %s 200 body matches the contract', (_, body) => {
    expect(ok(body), JSON.stringify(ok.errors)).toBe(true)
  })

  it.each([READER, READER_AND_ADMIN, ADMIN_ONLY])(
    'the client hands every contract-valid body on unchanged',
    async (body) => {
      expect(await createApi(async () => json(200, body)).getMe()).toEqual({ kind: 'ok', me: body })
    },
  )

  it('the client turns the contract 403 into a denial carrying its title', async () => {
    expect(await createApi(async () => problem(NO_ACCESS)).getMe()).toEqual({ kind: 'denied', problem: NO_ACCESS })
  })

  it('the 401 problem matches the contract', () => {
    expect(unauthenticated(UNAUTHENTICATED), JSON.stringify(unauthenticated.errors)).toBe(true)
  })

  it('the 403 no-access problem matches the contract', () => {
    expect(denied(NO_ACCESS), JSON.stringify(denied.errors)).toBe(true)
  })

  it('a 403 problem carrying anything beyond type, title, status and traceId breaks the contract', () => {
    expect(denied({ ...NO_ACCESS, detail: 'extra' })).toBe(false)
  })
})

describe('IF-1 GET /auth/login problems', () => {
  it('the 503 problem shape matches the contract', () => {
    const unavailable = validatorFor('IF-1', '/auth/login', '503', 'application/problem+json')
    expect(unavailable(SERVER_ERROR), JSON.stringify(unavailable.errors)).toBe(true)
  })
})

describe('IF-27 GET /api/v1/report-history fixtures', () => {
  const ok = validatorFor('IF-27', '/api/v1/report-history', '200', 'application/json')
  const problemFor = (status: string) =>
    validatorFor('IF-27', '/api/v1/report-history', status, 'application/problem+json')

  it.each([
    ['90 days of history', HISTORY],
    ['no reports yet', NO_REPORTS_YET],
  ])('the %s 200 body matches the contract', (_, body) => {
    expect(ok(body), JSON.stringify(ok.errors)).toBe(true)
  })

  it.each([
    ['400', BAD_REQUEST],
    ['401', UNAUTHENTICATED],
    ['403', NOT_A_READER],
    ['503', SERVER_ERROR],
  ])('the %s problem matches the contract', (status, body) => {
    const validate = problemFor(status)
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true)
  })

  it('a day carrying a figure the contract does not define breaks the contract', () => {
    const [first, ...rest] = HISTORY.items
    expect(ok({ ...HISTORY, items: [{ ...first, share: 0.5 }, ...rest] })).toBe(false)
  })

  it('the client hands every contract-valid body on unchanged', async () => {
    for (const body of [HISTORY, NO_REPORTS_YET]) {
      expect(await createApi(async () => json(200, body)).getReportHistory()).toEqual({ kind: 'ok', history: body })
    }
  })
})
