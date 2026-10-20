/* A small evaluator for ALB listener rules as written in terraform/*.tf.json:
 * rules are tried in ascending priority, path-pattern values are case-sensitive
 * globs (* and ?) matched against the path without its query string, and the
 * listener's default action applies when no rule matches. */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type Json = Record<string, unknown>
export const TERRAFORM_DIR = new URL('../../terraform/', import.meta.url).pathname

/** Merge every *.tf.json in the module the way Terraform does: one namespace per block type. */
export function loadModule(dir = TERRAFORM_DIR): Json {
  const merged: Record<string, Record<string, unknown>> = {}
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.tf.json'))) {
    const doc = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Json
    for (const [kind, body] of Object.entries(doc)) {
      if (kind === '//') continue
      merged[kind] ??= {}
      for (const [name, value] of Object.entries(body as Json)) {
        if (kind !== 'terraform' && kind !== 'provider' && name in merged[kind]!) {
          throw new Error(`${kind}.${name} is declared twice`)
        }
        const existing = merged[kind]![name]
        if (kind === 'resource' || kind === 'data') {
          merged[kind]![name] = { ...(existing as Json), ...(value as Json) }
        } else {
          merged[kind]![name] = value
        }
      }
    }
  }
  return merged
}

export function resources(mod: Json, type: string): Record<string, Json> {
  return ((mod.resource as Json | undefined)?.[type] ?? {}) as Record<string, Json>
}

/** Terraform JSON lets a nested block be one object or a list of them. */
export function blocks(value: unknown): Json[] {
  if (value === undefined) return []
  return (Array.isArray(value) ? value : [value]) as Json[]
}

export function block(value: unknown): Json {
  const list = blocks(value)
  if (list.length !== 1) throw new Error(`expected exactly one block, got ${list.length}`)
  return list[0]!
}

function globToRegExp(glob: string): RegExp {
  const body = glob
    .split('')
    .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\/]/g, '\\$&')))
    .join('')
  return new RegExp(`^${body}$`)
}

function destinationOf(action: Json, targetGroups: Record<string, string>): string {
  if (action.type === 'fixed-response') {
    const status = block(action.fixed_response).status_code
    return status === '404' || status === '403' ? 'deny' : `fixed-${String(status)}`
  }
  if (action.type === 'forward') {
    const ref = String(action.target_group_arn)
    const name = /\$\{aws_lb_target_group\.([a-z_]+)\.arn\}/.exec(ref)?.[1]
    if (!name || !(name in targetGroups)) throw new Error(`unknown target group ${ref}`)
    return targetGroups[name]!
  }
  throw new Error(`unsupported action ${String(action.type)}`)
}

/** Route a request through the ALB listener; target groups map to 'api' / 'keycloak' by name. */
export function routeAlb(mod: Json, requestTarget: string): string {
  const path = requestTarget.split('?')[0]!
  const targetGroups = Object.fromEntries(Object.keys(resources(mod, 'aws_lb_target_group')).map((n) => [n, n]))
  const listener = block(Object.values(resources(mod, 'aws_lb_listener')))
  const rules = Object.values(resources(mod, 'aws_lb_listener_rule')).sort(
    (a, b) => Number(a.priority) - Number(b.priority),
  )
  for (const rule of rules) {
    const patterns = blocks(rule.condition).flatMap((c) => blocks(c.path_pattern).flatMap((p) => p.values as string[]))
    if (patterns.some((p) => globToRegExp(p).test(path))) {
      return destinationOf(block(rule.action), targetGroups)
    }
  }
  return destinationOf(block(listener.default_action), targetGroups)
}
