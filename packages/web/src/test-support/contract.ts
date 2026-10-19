/* Validates test fixtures against the committed OpenAPI contracts, so every mocked response
 * the web tests use is one the BFF is allowed to send. Covers the JSON Schema subset the
 * contracts use: $ref, type, required, additionalProperties, enum, const, pattern, uniqueItems. */
import { readFileSync } from 'node:fs'

type Schema = Record<string, unknown>

export interface Contract {
  responseSchema(path: string, method: string, status: number, mediaType: string): Schema
  parameterSchema(path: string, method: string, name: string): Schema
}

export function loadContract(name: string): Contract {
  const url = new URL(`./contracts/${name}.json`, import.meta.url)
  const document = JSON.parse(readFileSync(url, 'utf8')) as Schema
  return {
    responseSchema(path, method, status, mediaType) {
      const operation = (document.paths as Record<string, Record<string, Schema>>)[path]?.[method]
      const response = (operation?.responses as Record<string, Schema> | undefined)?.[String(status)]
      const content = (response?.content as Record<string, Schema> | undefined)?.[mediaType]
      if (!content) throw new Error(`${name} has no ${mediaType} ${status} response for ${method} ${path}`)
      return { ...(content.schema as Schema), $document: document }
    },
    parameterSchema(path, method, name) {
      const operation = (document.paths as Record<string, Record<string, Schema>>)[path]?.[method]
      const parameter = ((operation?.parameters ?? []) as Schema[]).find((candidate) => candidate.name === name)
      if (!parameter) throw new Error(`the contract has no parameter ${name} on ${method} ${path}`)
      return { ...(parameter.schema as Schema), $document: document }
    },
  }
}

function resolve(schema: Schema, document: Schema): Schema {
  const ref = schema.$ref
  if (typeof ref !== 'string') return schema
  const target = ref
    .replace(/^#\//, '')
    .split('/')
    .reduce<unknown>((node, key) => (node as Schema)[key], document)
  return target as Schema
}

export function validate(value: unknown, root: Schema, at = '$'): string[] {
  const document = root.$document as Schema
  const schema = resolve(root, document)
  const errors: string[] = []
  const child = (sub: unknown, subSchema: Schema, path: string) =>
    errors.push(...validate(sub, { ...subSchema, $document: document }, path))
  if ('const' in schema && value !== schema.const) errors.push(`${at} must equal ${String(schema.const)}`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${at} is not in the enum`)
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${at} must be an object`]
      const record = value as Record<string, unknown>
      const properties = (schema.properties ?? {}) as Record<string, Schema>
      for (const key of (schema.required ?? []) as string[]) {
        if (!(key in record)) errors.push(`${at}.${key} is required`)
      }
      for (const [key, sub] of Object.entries(record)) {
        if (properties[key]) child(sub, properties[key], `${at}.${key}`)
        else if (schema.additionalProperties === false) errors.push(`${at}.${key} is not allowed`)
      }
      break
    }
    case 'array': {
      if (!Array.isArray(value)) return [`${at} must be an array`]
      if (schema.uniqueItems && new Set(value).size !== value.length) errors.push(`${at} must hold unique items`)
      value.forEach((item, index) => child(item, schema.items as Schema, `${at}[${index}]`))
      break
    }
    case 'string':
      if (typeof value !== 'string') return [`${at} must be a string`]
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
        errors.push(`${at} does not match ${schema.pattern}`)
      }
      if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) errors.push(`${at} must be a date-time`)
      break
    case 'integer':
      if (!Number.isInteger(value)) errors.push(`${at} must be an integer`)
      break
  }
  return errors
}
