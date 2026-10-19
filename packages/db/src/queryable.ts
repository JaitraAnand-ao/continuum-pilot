/* The one thing the stores need from node-postgres: a pg Pool, PoolClient or Client fits. */
export interface Queryable {
  query<R>(text: string, values: readonly unknown[]): Promise<{ rows: R[]; rowCount: number | null }>
}
