/* A stand-in for a pg Client: records every statement Drizzle sends and answers from a handler.
 * Rows are answered in array mode, in the table's column order, as node-postgres would. */
import { getTableColumns } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'

export interface Statement {
  readonly text: string
  readonly params: readonly unknown[]
}

export type Handler = (statement: Statement) => unknown[][] | undefined

export class FakePgClient {
  readonly statements: Statement[] = []
  #handler: Handler

  constructor(handler: Handler = () => []) {
    this.#handler = handler
  }

  async query(config: string | { text: string }, params: unknown[] = []) {
    const text = typeof config === 'string' ? config : config.text
    const statement = { text, params }
    this.statements.push(statement)
    const rows = this.#handler(statement) ?? []
    return { rows, rowCount: rows.length, command: text.split(' ')[0]?.toUpperCase() ?? '', fields: [] }
  }

  texts(): string[] {
    return this.statements.map((statement) => statement.text)
  }
}

/** One row of `table` in array mode, values given by property name (the Drizzle key). */
export function row(table: PgTable, values: Record<string, unknown>): unknown[] {
  return Object.keys(getTableColumns(table)).map((key) => values[key] ?? null)
}
