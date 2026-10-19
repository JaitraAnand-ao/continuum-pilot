/* Test support: validates fixtures against the OpenAPI contracts, so every mock the web
 * tests use is proven to be a response the BFF may actually send (contracts-honoured).
 * packages/api/openapi.json, the document api-client is generated from, is the authority
 * for every operation it documents; the pinned step-7 copies stand in for the rest.
 * Covers the JSON Schema keywords the IF-1 and IF-4 contracts use, nothing more. */
import { readFileSync } from 'node:fs'

export const OPENAPI_PATH = new URL('../../../api/openapi.json', import.meta.url).pathname

type Schema = {
  $ref?: string
  type?: string
  const?: unknown
  enum?: unknown[]
  pattern?: string
  format?: string
  required?: string[]
  properties?: Record<string, Schema>
  additionalProperties?: boolean
  items?: Schema
  uniqueItems?: boolean
}

type Contract = { paths: Record<string, Record<string, Operation>>; components?: { schemas?: Record<string, Schema> } }
type Operation = { responses: Record<string, { content?: Record<string, { schema: Schema }> }> }

const typeOf = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value

function check(contract: Contract, schema: Schema, value: unknown, at: string, errors: string[]): void {
  if (schema.$ref) {
    const name = schema.$ref.replace('#/components/schemas/', '')
    const target = contract.components?.schemas?.[name]
    if (!target) throw new Error(`unresolved ${schema.$ref}`)
    check(contract, target, value, at, errors)
    return
  }
  const actual = typeOf(value)
  if (schema.type && !(schema.type === actual || (schema.type === 'number' && actual === 'integer'))) {
    errors.push(`${at}: expected ${schema.type}, got ${actual}`)
    return
  }
  if ('const' in schema && schema.const !== value) errors.push(`${at}: expected ${JSON.stringify(schema.const)}`)
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} is not in the enum`)
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${at}: does not match pattern`)
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) errors.push(`${at}: not a date-time`)
  }
  if (Array.isArray(value)) {
    if (schema.uniqueItems && new Set(value).size !== value.length) errors.push(`${at}: items are not unique`)
    if (schema.items)
      value.forEach((item, index) => check(contract, schema.items as Schema, item, `${at}[${index}]`, errors))
  }
  if (actual === 'object') {
    const record = value as Record<string, unknown>
    for (const key of schema.required ?? []) if (!(key in record)) errors.push(`${at}: missing ${key}`)
    for (const [key, item] of Object.entries(record)) {
      const property = schema.properties?.[key]
      if (property) check(contract, property, item, `${at}.${key}`, errors)
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected property ${key}`)
    }
  }
}

/** packages/api/openapi.json when it documents `path`, otherwise the pinned contract copy. */
export function contractFor(
  path: string,
  pinned: unknown,
  published: unknown = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')),
): unknown {
  return (published as Contract).paths?.[path] ? published : pinned
}

/** The errors found validating `body` as the `status` response of `method path`; empty when it conforms. */
export function contractErrors(
  contract: unknown,
  method: string,
  path: string,
  status: number,
  mediaType: string,
  body: unknown,
): string[] {
  const document = contract as Contract
  const response = document.paths[path]?.[method]?.responses[String(status)]
  if (!response) return [`${method.toUpperCase()} ${path} documents no ${status} response`]
  const schema = response.content?.[mediaType]?.schema
  if (!schema) return [`${method.toUpperCase()} ${path} ${status} documents no ${mediaType} body`]
  const errors: string[] = []
  check(document, schema, body, '$', errors)
  return errors
}
