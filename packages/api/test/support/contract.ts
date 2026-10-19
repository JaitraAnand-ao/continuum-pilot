/* A narrow JSON Schema check, enough for the committed IF-1 and IF-4 contracts: the response a route sends must
 * be a status the contract documents, with the content type and body shape it declares. */
import { readFileSync } from 'node:fs'
import { expect } from 'vitest'

type Schema = Record<string, unknown>

export function loadContract(name: string): Schema {
  return JSON.parse(readFileSync(new URL(`../contracts/${name}.json`, import.meta.url), 'utf8')) as Schema
}

function resolve(document: Schema, schema: Schema): Schema {
  const ref = schema.$ref
  if (typeof ref !== 'string') return schema
  return ref
    .replace(/^#\//, '')
    .split('/')
    .reduce<Schema>((node, key) => node[key] as Schema, document)
}

export function violations(document: Schema, raw: Schema, value: unknown, path = '$'): string[] {
  const schema = resolve(document, raw)
  const found: string[] = []
  if ('const' in schema && value !== schema.const) found.push(`${path} is not ${String(schema.const)}`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) found.push(`${path} is not in the enum`)
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path} is not an object`]
      const record = value as Record<string, unknown>
      const properties = (schema.properties ?? {}) as Record<string, Schema>
      for (const key of (schema.required ?? []) as string[]) {
        if (!(key in record)) found.push(`${path}.${key} is missing`)
      }
      for (const [key, item] of Object.entries(record)) {
        const property = properties[key]
        if (property === undefined) {
          if (schema.additionalProperties === false) found.push(`${path}.${key} is not allowed`)
        } else found.push(...violations(document, property, item, `${path}.${key}`))
      }
      break
    }
    case 'array': {
      if (!Array.isArray(value)) return [`${path} is not an array`]
      if (schema.uniqueItems === true && new Set(value).size !== value.length) found.push(`${path} repeats an item`)
      value.forEach((item, index) =>
        found.push(...violations(document, schema.items as Schema, item, `${path}[${index}]`)),
      )
      break
    }
    case 'string': {
      if (typeof value !== 'string') return [`${path} is not a string`]
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
        found.push(`${path} does not match ${schema.pattern}`)
      }
      if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) found.push(`${path} is not a date-time`)
      if (schema.format === 'uri' && !URL.canParse(value)) found.push(`${path} is not a URI`)
      break
    }
    case 'integer':
      if (!Number.isInteger(value)) found.push(`${path} is not an integer`)
      break
  }
  return found
}

interface Sent {
  statusCode: number
  headers: Record<string, unknown>
  body: string
}

export function expectHonours(document: Schema, path: string, method: string, response: Sent): void {
  const operation = ((document.paths as Schema)[path] as Schema)[method] as Schema
  const documented = (operation.responses as Schema)[String(response.statusCode)] as Schema | undefined
  expect(documented, `${method.toUpperCase()} ${path} answered an undocumented ${response.statusCode}`).toBeDefined()
  const content = documented?.content as Record<string, { schema: Schema }> | undefined
  if (content !== undefined) {
    const [mediaType, media] = Object.entries(content)[0] as [string, { schema: Schema }]
    expect(String(response.headers['content-type'])).toContain(mediaType)
    expect(violations(document, media.schema, JSON.parse(response.body))).toEqual([])
  }
  const headers = (documented?.headers ?? {}) as Record<string, { schema: Schema }>
  for (const [name, header] of Object.entries(headers)) {
    if (name.toLowerCase() === 'set-cookie') continue
    const value = response.headers[name.toLowerCase()]
    expect(value, `${name} header is missing`).toBeDefined()
    expect(violations(document, header.schema, value)).toEqual([])
  }
}
