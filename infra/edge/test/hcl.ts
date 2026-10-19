/* Just enough HCL reading for the edge tests: top-level blocks by their labels, with
 * brace matching that skips strings, comments and heredocs. No Terraform binary needed. */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface Block {
  kind: string
  labels: string[]
  body: string
}

function stripComments(source: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (inString) {
      out += c
      if (c === '\\') {
        out += source[++i] ?? ''
      } else if (c === '"') {
        inString = false
      }
      continue
    }
    if (c === '"') {
      inString = true
      out += c
    } else if (c === '#' || (c === '/' && source[i + 1] === '/')) {
      while (i < source.length && source[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2) + 1
    } else {
      out += c
    }
  }
  return out
}

function closingBrace(source: string, open: number): number {
  let depth = 0
  let inString = false
  for (let i = open; i < source.length; i++) {
    const c = source[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  throw new Error('unbalanced braces')
}

/** Blocks at the depth the source starts at (top level of a file, or inside a body). */
export function blocks(source: string): Block[] {
  const text = stripComments(source)
  const found: Block[] = []
  const header = /(^|\n)[ \t]*([a-z_]+)((?:[ \t]+"[^"]*")*)[ \t]*\{/g
  let match: RegExpExecArray | null
  while ((match = header.exec(text)) !== null) {
    const open = match.index + match[0].length - 1
    const close = closingBrace(text, open)
    found.push({
      kind: match[2] ?? '',
      labels: [...(match[3] ?? '').matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? ''),
      body: text.slice(open + 1, close),
    })
    header.lastIndex = close + 1
  }
  return found
}

export function readModule(dir: string): Block[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.tf'))
    .flatMap((name) => blocks(readFileSync(join(dir, name), 'utf8')))
}

export function resources(module: Block[], type: string): Block[] {
  return module.filter((b) => b.kind === 'resource' && b.labels[0] === type)
}

export function resource(module: Block[], type: string, name: string): Block {
  const found = module.find((b) => b.kind === 'resource' && b.labels[0] === type && b.labels[1] === name)
  if (!found) throw new Error(`resource ${type}.${name} is not declared`)
  return found
}

/** The raw expression assigned to a top-level attribute of a body, up to the end of its line. */
export function attr(body: string, name: string): string | undefined {
  let flattened = body
  while (/\{[^{}]*\}/.test(flattened)) flattened = flattened.replace(/\{[^{}]*\}/g, (s) => ' '.repeat(s.length))
  const match = new RegExp(`(^|\\n)[ \\t]*${name}[ \\t]*=[ \\t]*`).exec(flattened)
  if (!match) return undefined
  const start = match.index + match[0].length
  const rest = body.slice(start)
  if (rest.startsWith('[')) return rest.slice(0, rest.indexOf(']') + 1)
  return rest.split('\n')[0]?.trim()
}

export function stringList(expression: string | undefined): string[] {
  return [...(expression ?? '').matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? '')
}

export function unquote(expression: string | undefined): string | undefined {
  return expression?.replace(/^"(.*)"$/, '$1')
}
