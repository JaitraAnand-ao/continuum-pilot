import { createHash } from 'node:crypto'
import pg from 'pg'
import { runMigrations } from '../src/migrate.js'

/* Integration tests run against the disposable PostgreSQL the sandbox provides and skip cleanly without it. */
export const databaseUrl = process.env.AGENTX_TEST_DATABASE_URL
export const noDatabase = !databaseUrl

export const CHECK_VIOLATION = '23514'
export const UNIQUE_VIOLATION = '23505'
export const INSUFFICIENT_PRIVILEGE = '42501'
export const RAISED = 'P0001'

export async function migratedPool(): Promise<pg.Pool> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
  await runMigrations(pool)
  return pool
}

/* Runs fn inside a transaction, optionally as one of the application roles, then rolls back so tests share nothing. */
export async function rolledBack<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
  role?: string,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (role) await client.query(`SET LOCAL ROLE ${client.escapeIdentifier(role)}`)
    return await fn(client)
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

/* Resolves to the SQLSTATE the statement failed with, or null when it succeeded; a savepoint keeps the transaction usable. */
export async function sqlState(client: pg.PoolClient, text: string, values: unknown[] = []): Promise<string | null> {
  await client.query('SAVEPOINT attempt')
  try {
    await client.query(text, values)
    await client.query('RELEASE SAVEPOINT attempt')
    return null
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT attempt')
    return (error as { code?: string }).code ?? 'unknown'
  }
}

export interface SignInRow {
  id: string
  createdDateTime: string
  signInEventType: string
  errorCode: number
  conditionalAccessPolicies: { id: string; displayName: string; result: string }[]
  deviceDetail: { deviceId: string; operatingSystem: string; browser: string; isCompliant: boolean; isManaged: boolean }
}

export function signIn(overrides: Partial<SignInRow> = {}): SignInRow {
  return {
    id: 'sign-in-1',
    createdDateTime: '2026-10-11T12:00:00.000Z',
    signInEventType: 'interactiveUser',
    errorCode: 0,
    conditionalAccessPolicies: [{ id: 'ca-1', displayName: 'Require MFA', result: 'success' }],
    deviceDetail: { deviceId: 'd-1', operatingSystem: 'Windows', browser: 'Edge', isCompliant: true, isManaged: true },
    ...overrides,
  }
}

export interface ReportRow {
  reportDate: string
  windowStart: string
  windowEnd: string
  status: string
  missingSources: string[]
  total: number
  successful: number
  failed: number
  snapshot: { signIns: unknown[]; riskDetections: unknown[] }
  contentHash: string
  publishedAt: string
}

function nextDay(reportDate: string): string {
  const day = new Date(`${reportDate}T00:00:00.000Z`)
  day.setUTCDate(day.getUTCDate() + 1)
  return day.toISOString()
}

/* A report as the report worker would publish it: figures and hash computed from the snapshot. */
export function report(reportDate: string, signIns: SignInRow[] = [], overrides: Partial<ReportRow> = {}): ReportRow {
  const successful = signIns.filter((s) => s.errorCode === 0).length
  const base = {
    reportDate,
    windowStart: `${reportDate}T00:00:00.000Z`,
    windowEnd: nextDay(reportDate),
    status: 'complete',
    missingSources: [] as string[],
    total: signIns.length,
    successful,
    failed: signIns.length - successful,
    snapshot: { signIns, riskDetections: [] as unknown[] },
    publishedAt: nextDay(reportDate).replace('T00:00:00.000Z', 'T02:05:00.000Z'),
    ...overrides,
  }
  return { contentHash: contentHash(base), ...base, ...overrides }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/* SHA-256 over key-sorted JSON, so it survives the jsonb round trip. */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

/* The statement the report worker publishes with (CMP-3 PgReportStore): a second publish for a date is a no-op. */
export const PUBLISH = `
  INSERT INTO report (report_date, window_start, window_end, status, missing_sources,
                      total, successful, failed, snapshot, content_hash, published_at)
  VALUES ($1::date, $2::timestamptz, $3::timestamptz, $4, $5::text[], $6, $7, $8, $9::jsonb, $10, $11::timestamptz)
  ON CONFLICT (report_date) DO NOTHING`

export function publishValues(row: ReportRow): unknown[] {
  return [
    row.reportDate,
    row.windowStart,
    row.windowEnd,
    row.status,
    row.missingSources,
    row.total,
    row.successful,
    row.failed,
    JSON.stringify(row.snapshot),
    row.contentHash,
    row.publishedAt,
  ]
}

export const publish = (client: pg.PoolClient, row: ReportRow) => client.query(PUBLISH, publishValues(row))
export const tryPublish = (client: pg.PoolClient, row: ReportRow) => sqlState(client, PUBLISH, publishValues(row))

/* The worker's not-generated upsert (CMP-3 PgReportStore). */
export const RECORD_NOT_GENERATED = `
  INSERT INTO report_not_generated (report_date, missing_sources, recorded_at)
  VALUES ($1::date, $2::text[], $3::timestamptz)
  ON CONFLICT (report_date) DO UPDATE
    SET missing_sources = EXCLUDED.missing_sources, recorded_at = EXCLUDED.recorded_at`
