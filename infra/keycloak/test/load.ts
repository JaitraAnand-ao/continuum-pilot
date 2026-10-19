import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const keycloakDir = join(import.meta.dirname, '..')

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }

export function readText(relative: string): string {
  return readFileSync(join(keycloakDir, relative), 'utf8')
}

export function readJson(relative: string): JsonObject {
  return JSON.parse(readText(relative)) as JsonObject
}

export function asObjects(value: Json | undefined): JsonObject[] {
  return Array.isArray(value) ? (value as JsonObject[]) : []
}

export function asObject(value: Json | undefined): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** Every [path, value] pair of string leaves, for secret and partition sweeps. */
export function stringLeaves(value: Json, path = '$'): Array<[string, string]> {
  if (typeof value === 'string') return [[path, value]]
  if (Array.isArray(value)) return value.flatMap((item, index) => stringLeaves(item, `${path}[${index}]`))
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => stringLeaves(item, `${path}.${key}`))
  }
  return []
}

/** An import-time environment placeholder (${NAME}) or a Keycloak vault reference (${vault.name}). */
export const placeholder = /^\$\{(?:vault\.[a-z0-9_]+|[A-Z][A-Z0-9_]*)\}$/
