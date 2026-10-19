import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const here = join(import.meta.dirname, '..')

export function readText(relative: string): string {
  return readFileSync(join(here, relative), 'utf8')
}

/* Keycloak realm exports are loosely typed JSON; the tests index into them as JSON.parse returns them. */
export type Json = ReturnType<typeof JSON.parse>

export function readJson(relative: string): Json {
  return JSON.parse(readText(relative))
}

export const signinRealmPath = 'realms/signin-reports-realm.json'
export const fakeEntraRealmPath = 'realms/local/fake-entra-realm.json'

/** Every `${NAME}` or `${NAME:default}` environment placeholder Keycloak resolves at import. */
export function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\$\{([A-Z][A-Z0-9_]*)(?::[^}]*)?\}/g)].map((match) => match[1] as string))]
}

export const isPlaceholder = (value: unknown): boolean =>
  typeof value === 'string' && /^\$\{[A-Z][A-Z0-9_]*(?::[^}]*)?\}$/.test(value)

/** Walks a JSON tree, yielding each [key, value] pair with its path. */
export function* walk(node: Json, path: string[] = []): Generator<[string[], string, Json]> {
  if (Array.isArray(node)) {
    for (const [index, child] of node.entries()) yield* walk(child, [...path, String(index)])
  } else if (node !== null && typeof node === 'object') {
    for (const [key, child] of Object.entries(node)) {
      yield [path, key, child]
      yield* walk(child, [...path, key])
    }
  }
}
