/* contracts-honoured: validates a response against the committed OpenAPI contract's schema, using the same
 * Ajv (with formats, nothing removed or coerced) that Fastify ships. */
import { readFileSync } from 'node:fs'
import Fastify from 'fastify'

type Json = Record<string, unknown>

/* The provided contracts as approved for ST-1; the repository's contracts/ still holds placeholders for them. */
const root = new URL('../../contracts/', import.meta.url)

export function loadContract(name: string): Json {
  return JSON.parse(readFileSync(new URL(`${name}.json`, root), 'utf8')) as Json
}

function deref(document: Json, node: unknown): unknown {
  if (Array.isArray(node)) return node.map((item) => deref(document, item))
  if (!node || typeof node !== 'object') return node
  const ref = (node as Json).$ref
  if (typeof ref === 'string') {
    const target = ref
      .slice(2)
      .split('/')
      .reduce<unknown>((value, key) => (value as Json)[key], document)
    return deref(document, target)
  }
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, deref(document, value)]))
}

export function responseSchema(contract: Json, path: string, method: string, status: number, type: string): Json {
  const operation = ((contract.paths as Json)[path] as Json)[method] as Json
  const response = (operation.responses as Json)[String(status)] as Json
  return deref(contract, ((response.content as Json)[type] as Json).schema) as Json
}

export function headerSchema(contract: Json, path: string, method: string, status: number, name: string): Json {
  const operation = ((contract.paths as Json)[path] as Json)[method] as Json
  const response = (operation.responses as Json)[String(status)] as Json
  return deref(contract, ((response.headers as Json)[name] as Json).schema) as Json
}

/* True when the contract declares the status with no body, such as a 204. */
export function declaresNoContent(contract: Json, path: string, method: string, status: number): boolean {
  const operation = ((contract.paths as Json)[path] as Json)[method] as Json
  const response = (operation.responses as Json)[String(status)] as Json | undefined
  return response !== undefined && response.content === undefined
}

export function parameterSchema(contract: Json, path: string, method: string, name: string): Json {
  const operation = ((contract.paths as Json)[path] as Json)[method] as Json
  const parameter = (operation.parameters as Json[]).find((candidate) => candidate.name === name) as Json
  return parameter.schema as Json
}

/* Resolves to the list of validation errors (empty when the value satisfies the schema). */
export async function violations(schema: Json, value: unknown): Promise<string[]> {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } } })
  app.post(
    '/',
    { schema: { body: { type: 'object', properties: { value: schema }, required: ['value'] } } },
    () => ({}),
  )
  const response = await app.inject({ method: 'POST', url: '/', payload: { value } })
  await app.close()
  return response.statusCode === 200 ? [] : [String(response.json<{ message: string }>().message)]
}
