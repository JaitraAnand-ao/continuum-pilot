/* Validates a response against the committed contract copy in packages/api/contracts: the status must be documented,
 * and its headers and body must match the documented schemas. */
import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { LightMyRequestResponse } from 'fastify'
import { expect } from 'vitest'

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
  const document = JSON.parse(readFileSync(new URL(`../../contracts/${name}.json`, import.meta.url), 'utf8'))
  const ajv = new Ajv2020({ strict: false, allErrors: true })
  addFormats.default(ajv)
  ajv.addSchema({ $id: 'contract', components: document.components })
  return { document, ajv }
}

function rewrite(schema: object): object {
  return JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"contract#/components/'))
}

export function check(name: string, path: string, method: string, response: LightMyRequestResponse) {
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
