import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Me } from '../src/api/client'

/* Fixtures are checked against the committed IF-4 contract (contracts/IF-4.json) before any test uses them. */

type Schema = {
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
  $ref?: string
}

const contract = JSON.parse(readFileSync(fileURLToPath(new URL('./contracts/IF-4.json', import.meta.url)), 'utf8'))

function resolve(schema: Schema): Schema {
  if (schema.$ref === undefined) return schema
  const name = schema.$ref.replace('#/components/schemas/', '')
  return contract.components.schemas[name]
}

/* A JSON Schema subset, enough for IF-4; returns the paths that violate it. */
export function violations(value: unknown, raw: Schema, path = '$'): string[] {
  const schema = resolve(raw)
  const problems: string[] = []
  if ('const' in schema && value !== schema.const) problems.push(`${path}: not ${String(schema.const)}`)
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${path}: not in enum`)
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') return [`${path}: not a string`]
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) problems.push(`${path}: pattern`)
      if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) problems.push(`${path}: date-time`)
      break
    case 'integer':
      if (!Number.isInteger(value)) problems.push(`${path}: not an integer`)
      break
    case 'array':
      if (!Array.isArray(value)) return [`${path}: not an array`]
      if (schema.uniqueItems && new Set(value).size !== value.length) problems.push(`${path}: duplicates`)
      value.forEach((item, index) => problems.push(...violations(item, schema.items ?? {}, `${path}[${index}]`)))
      break
    case 'object': {
      if (typeof value !== 'object' || value === null) return [`${path}: not an object`]
      const record = value as Record<string, unknown>
      for (const key of schema.required ?? []) if (!(key in record)) problems.push(`${path}.${key}: missing`)
      for (const [key, item] of Object.entries(record)) {
        const property = schema.properties?.[key]
        if (property) problems.push(...violations(item, property, `${path}.${key}`))
        else if (schema.additionalProperties === false) problems.push(`${path}.${key}: not allowed`)
      }
      break
    }
  }
  return problems
}

export function responseSchema(status: string): Schema {
  const response = contract.paths['/api/v1/me'].get.responses[status]
  const content = response.content['application/json'] ?? response.content['application/problem+json']
  return content.schema
}

function checked<T>(status: string, value: T): T {
  const found = violations(value, responseSchema(status))
  if (found.length > 0) throw new Error(`fixture breaks IF-4 ${status}: ${found.join('; ')}`)
  return value
}

export const SIGNED_IN_AT = Date.parse('2026-10-19T08:00:00Z')

export function meFor(roles: Me['roles'], overrides: Partial<Me> = {}): Me {
  return checked('200', {
    account: 'm.duarte@contoso.com',
    displayName: 'Marta Duarte',
    roles,
    authTime: '2026-10-19T08:00:00Z',
    idleExpiresAt: '2026-10-19T08:15:00Z',
    absoluteExpiresAt: '2026-10-19T16:00:00Z',
    ...overrides,
  })
}

export const NO_ACCESS = checked('403', {
  type: '/problems/no-access',
  title: "You don't have access. Signed in as j.outsider@contoso.com.",
  status: 403,
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
})

export const UNAUTHORIZED = checked('401', {
  type: '/problems/unauthorized',
  title: 'Sign in to continue',
  status: 401,
  traceId: '0af7651916cd43dd8448eb211c80319c',
})

export function jsonResponse(status: number, body: unknown, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType } })
}
