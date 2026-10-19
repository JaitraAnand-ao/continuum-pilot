/* Test-only: validates a response against the committed IF contract it provides (copied from the step-7
 * contracts, which this part develops against exactly). */
import { readFileSync } from 'node:fs'
import { z } from 'zod'

type Json = Record<string, unknown>

const contracts: Record<string, Json> = {
  'IF-1': JSON.parse(readFileSync(new URL('./contracts/IF-1.json', import.meta.url), 'utf8')) as Json,
  'IF-4': JSON.parse(readFileSync(new URL('./contracts/IF-4.json', import.meta.url), 'utf8')) as Json,
}

/* Inline $refs, and drop format uri-reference: zod treats it as an absolute URL, while the contracts use
 * it for relative problem types such as /problems/no-access. */
function resolve(node: unknown, root: Json): unknown {
  if (Array.isArray(node)) return node.map((item) => resolve(item, root))
  if (node === null || typeof node !== 'object') return node
  const object = node as Json
  if (typeof object.$ref === 'string') {
    const target = object.$ref
      .slice(2)
      .split('/')
      .reduce<unknown>((at, key) => (at as Json)[key], root)
    return resolve(target, root)
  }
  const out: Json = {}
  for (const [key, value] of Object.entries(object)) {
    if (key === 'format' && value === 'uri-reference') continue
    out[key] = resolve(value, root)
  }
  return out
}

export interface ContractResponse {
  statusCode: number
  headers: Record<string, unknown>
  body: string
}

/** Throws unless the status is documented and the body matches its schema and media type. */
export function assertHonoursContract(contract: 'IF-1' | 'IF-4', path: string, response: ContractResponse): void {
  const root = contracts[contract] as Json
  const operation = ((root.paths as Json)[path] as Json).get as Json
  const documented = (operation.responses as Json)[String(response.statusCode)] as Json | undefined
  if (documented === undefined) throw new Error(`${contract} does not document status ${response.statusCode}`)
  const content = documented.content as Json | undefined
  if (content === undefined) return
  const mediaType = Object.keys(content)[0] as string
  const contentType = String(response.headers['content-type'] ?? '')
  if (!contentType.startsWith(mediaType)) throw new Error(`expected ${mediaType}, got ${contentType}`)
  const schema = resolve((content[mediaType] as Json).schema, root) as Parameters<typeof z.fromJSONSchema>[0]
  z.fromJSONSchema(schema).parse(JSON.parse(response.body))
}
