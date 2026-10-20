import type pg from 'pg'

/* A day of sign-ins shaped like the snapshot the report worker stores, and the figures it publishes with it. */

export const SCOPES = ['all', 'interactiveUser', 'nonInteractiveUser', 'servicePrincipal', 'managedIdentity'] as const
export type Scope = (typeof SCOPES)[number]

export interface FixtureSignIn {
  id: string
  createdDateTime: string
  signInEventType: Exclude<Scope, 'all'>
  appId: string
  appDisplayName: string
  errorCode: number
}

export interface AppFigures {
  appId: string
  appDisplayName: string
  total: number
  successful: number
  failed: number
}

export interface CodeFigures {
  errorCode: number
  failed: number
}

export interface ScopeFigures {
  total: number
  successful: number
  failed: number
  errorCodeCount: number
  applications: AppFigures[]
  errorCodes: CodeFigures[]
}

export type Figures = Record<Scope, ScopeFigures>

const EXCHANGE = { appId: '00000002-0000-0ff1-ce00-000000000000', appDisplayName: 'Exchange Online' }
const WORKDAY = { appId: '11111111-1111-4111-8111-111111111111', appDisplayName: 'Workday' }
const OTHERS = Array.from({ length: 31 }, (_, i) => ({
  appId: `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`,
  appDisplayName: `Application ${String(i + 1).padStart(2, '0')}`,
}))
export const APPLICATIONS = [EXCHANGE, WORKDAY, ...OTHERS]

/* 50126, 50053 and 53003 among others; no managed identity sign-ins (AC-5). */
const CODES = [0, 0, 0, 50126, 0, 50053, 0, 53003, 0, 50126, 0, 70044, 0, 50076]
const TYPES = ['interactiveUser', 'nonInteractiveUser', 'servicePrincipal'] as const

export function daySignIns(date = '2026-10-11', count = 120): FixtureSignIn[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `s-${i}`,
    createdDateTime: `${date}T${String(i % 24).padStart(2, '0')}:00:00.000Z`,
    signInEventType: TYPES[i % TYPES.length] as FixtureSignIn['signInEventType'],
    ...(APPLICATIONS[i % APPLICATIONS.length] as (typeof APPLICATIONS)[number]),
    errorCode: CODES[i % CODES.length] as number,
  }))
}

function scopeFigures(signIns: readonly FixtureSignIn[]): ScopeFigures {
  const apps = new Map<string, AppFigures>()
  const codes = new Map<number, number>()
  for (const s of signIns) {
    const app = apps.get(s.appId) ?? {
      ...{ appId: s.appId, appDisplayName: s.appDisplayName },
      total: 0,
      successful: 0,
      failed: 0,
    }
    app.total += 1
    if (s.errorCode === 0) app.successful += 1
    else {
      app.failed += 1
      codes.set(s.errorCode, (codes.get(s.errorCode) ?? 0) + 1)
    }
    apps.set(s.appId, app)
  }
  const failed = signIns.filter((s) => s.errorCode !== 0).length
  return {
    total: signIns.length,
    successful: signIns.length - failed,
    failed,
    errorCodeCount: codes.size,
    applications: [...apps.values()],
    errorCodes: [...codes].map(([errorCode, n]) => ({ errorCode, failed: n })),
  }
}

export function figuresOf(signIns: readonly FixtureSignIn[]): Figures {
  return Object.fromEntries(
    SCOPES.map((scope) => [
      scope,
      scopeFigures(scope === 'all' ? signIns : signIns.filter((s) => s.signInEventType === scope)),
    ]),
  ) as Figures
}

export const HASH = 'c'.repeat(64)

export function insertReport(client: pg.PoolClient, date: string, signIns: readonly FixtureSignIn[]) {
  const failed = signIns.filter((s) => s.errorCode !== 0).length
  const next = new Date(Date.parse(`${date}T00:00:00.000Z`) + 86_400_000).toISOString()
  return client.query(
    `INSERT INTO report (report_date, window_start, window_end, status, missing_sources,
                         total, successful, failed, snapshot, content_hash, published_at)
     VALUES ($1::date, $2::timestamptz, $3::timestamptz, 'complete', '{}'::text[], $4, $5, $6, $7::jsonb, $8,
             $9::timestamptz)`,
    [
      date,
      `${date}T00:00:00.000Z`,
      next,
      signIns.length,
      signIns.length - failed,
      failed,
      JSON.stringify({ signIns, riskDetections: [] }),
      HASH,
      next.replace('T00:00:00.000Z', 'T02:15:30.123Z'),
    ],
  )
}

export function insertScope(
  client: pg.PoolClient,
  date: string,
  scope: string,
  f: Omit<ScopeFigures, 'applications' | 'errorCodes'>,
) {
  return client.query(
    `INSERT INTO report_figures (report_date, sign_in_type, total, successful, failed, error_code_count)
     VALUES ($1::date, $2, $3, $4, $5, $6)`,
    [date, scope, f.total, f.successful, f.failed, f.errorCodeCount],
  )
}

export function insertApplication(client: pg.PoolClient, date: string, scope: string, a: AppFigures) {
  return client.query(
    `INSERT INTO report_application_figures (report_date, sign_in_type, app_id, app_display_name, total, successful, failed)
     VALUES ($1::date, $2, $3, $4, $5, $6, $7)`,
    [date, scope, a.appId, a.appDisplayName, a.total, a.successful, a.failed],
  )
}

export function insertErrorCode(client: pg.PoolClient, date: string, scope: string, c: CodeFigures) {
  return client.query(
    `INSERT INTO report_error_code_figures (report_date, sign_in_type, error_code, failed)
     VALUES ($1::date, $2, $3, $4)`,
    [date, scope, c.errorCode, c.failed],
  )
}

/* Writes every figure row the report worker publishes alongside the report. */
export async function insertFigures(client: pg.PoolClient, date: string, figures: Figures): Promise<void> {
  for (const scope of SCOPES) {
    const f = figures[scope]
    await insertScope(client, date, scope, f)
    for (const a of f.applications) await insertApplication(client, date, scope, a)
    for (const c of f.errorCodes) await insertErrorCode(client, date, scope, c)
  }
}

/* Runs the deferred reconciliation checks now, as COMMIT would, resolving to the SQLSTATE or null. */
export async function reconcileState(client: pg.PoolClient): Promise<string | null> {
  try {
    await client.query('SET CONSTRAINTS ALL IMMEDIATE')
    return null
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown'
  }
}
