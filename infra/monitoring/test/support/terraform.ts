import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/* Loads every *.tf.json file of the module and merges them the way Terraform does. */

export const moduleDir = fileURLToPath(new URL('../../', import.meta.url))

type Block = Record<string, unknown>
export type Module = {
  terraform: Block
  provider: Record<string, Block>
  variable: Record<string, Block>
  data: Record<string, Record<string, Block>>
  resource: Record<string, Record<string, Block>>
  output: Record<string, Block>
  raw: string
}

export function loadModule(): Module {
  const files = readdirSync(moduleDir).filter((f) => f.endsWith('.tf.json'))
  const merged: Module = { terraform: {}, provider: {}, variable: {}, data: {}, resource: {}, output: {}, raw: '' }
  for (const file of files) {
    const text = readFileSync(moduleDir + file, 'utf8')
    merged.raw += text
    const doc = JSON.parse(text) as Record<string, Record<string, unknown>>
    for (const [kind, body] of Object.entries(doc)) {
      if (kind === 'terraform') Object.assign(merged.terraform, body)
      else if (kind === 'data' || kind === 'resource') {
        for (const [type, named] of Object.entries(body)) {
          merged[kind][type] = { ...merged[kind][type], ...(named as Record<string, Block>) }
        }
      } else Object.assign(merged[kind as 'provider' | 'variable' | 'output'], body)
    }
  }
  return merged
}

export function resources(mod: Module, type: string): Record<string, Block> {
  return mod.resource[type] ?? {}
}

export function resource(mod: Module, type: string, name: string): Block {
  const found = resources(mod, type)[name]
  if (!found) throw new Error(`resource ${type}.${name} is not declared`)
  return found
}

export function readContract(): {
  namespace: string
  metrics: Record<string, { name: string; unit: string; dimensions: Record<string, string>; periodSeconds: number }>
} {
  return JSON.parse(readFileSync(moduleDir + 'metrics.json', 'utf8'))
}

/* Every string anywhere in a JSON value. */
export function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}
