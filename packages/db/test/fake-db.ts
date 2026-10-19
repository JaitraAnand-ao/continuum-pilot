import type { Queryable } from '../src/index.js'

export interface RecordedQuery {
  text: string
  values: readonly unknown[]
}

/* A Queryable that records every statement and answers with the rows queued for it. */
export function fakeDb(...answers: { rows: unknown[]; rowCount?: number }[]) {
  const queries: RecordedQuery[] = []
  const db: Queryable = {
    async query<R>(text: string, values: readonly unknown[]) {
      queries.push({ text, values })
      const answer = answers.shift() ?? { rows: [] }
      return { rows: answer.rows as R[], rowCount: answer.rowCount ?? answer.rows.length }
    },
  }
  return { db, queries }
}
