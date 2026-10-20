import { SIGN_IN_TYPES, type SignIn, type Totals } from './model.js'
import { totalsOf } from './snapshot.js'

/* IF-18: the Daily report figures, computed once from the snapshot at publish and stored with it (ST-3).
   Readers show them as stored and never recompute them (AC-10). */

/* The sign-in type control's options, in the order it offers them (AC-4). */
export const SIGN_IN_TYPE_FILTERS = ['all', ...SIGN_IN_TYPES] as const
export type SignInTypeFilter = (typeof SIGN_IN_TYPE_FILTERS)[number]

export interface ApplicationFigures {
  appId: string
  appDisplayName: string
  signIns: number
  successful: number
  failed: number
}

export interface ErrorCodeFigures {
  errorCode: number
  failed: number
}

export interface TypeFigures {
  totals: Totals
  /* The number of distinct error codes shown on the Failed tile (AC-1). */
  errorCodeCount: number
  /* Highest sign-ins first, then name, then id: a fixed order, so the stored figures hash the same every time. */
  applications: ApplicationFigures[]
  /* Highest count first, then the lower code. */
  errorCodes: ErrorCodeFigures[]
}

export type DailyFigures = Record<SignInTypeFilter, TypeFigures>

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/* An application renamed during the day shows its name at its latest sign-in, the lower name on a tie,
   so the row does not depend on the order Graph returned the pages in. */
function namedLater(candidate: SignIn, current: SignIn): boolean {
  const a = Date.parse(candidate.createdDateTime)
  const b = Date.parse(current.createdDateTime)
  return a > b || (a === b && byName(candidate.appDisplayName, current.appDisplayName) < 0)
}

function applicationsOf(signIns: readonly SignIn[]): ApplicationFigures[] {
  const rows = new Map<string, ApplicationFigures>()
  const namedBy = new Map<string, SignIn>()
  for (const signIn of signIns) {
    let row = rows.get(signIn.appId)
    if (!row) {
      row = { appId: signIn.appId, appDisplayName: signIn.appDisplayName, signIns: 0, successful: 0, failed: 0 }
      rows.set(signIn.appId, row)
      namedBy.set(signIn.appId, signIn)
    } else if (namedLater(signIn, namedBy.get(signIn.appId)!)) {
      row.appDisplayName = signIn.appDisplayName
      namedBy.set(signIn.appId, signIn)
    }
    row.signIns++
    if (signIn.errorCode === 0) row.successful++
    else row.failed++
  }
  return [...rows.values()].sort(
    (a, b) => b.signIns - a.signIns || byName(a.appDisplayName, b.appDisplayName) || byName(a.appId, b.appId),
  )
}

function errorCodesOf(signIns: readonly SignIn[]): ErrorCodeFigures[] {
  const counts = new Map<number, number>()
  for (const { errorCode } of signIns) if (errorCode !== 0) counts.set(errorCode, (counts.get(errorCode) ?? 0) + 1)
  return [...counts]
    .map(([errorCode, failed]) => ({ errorCode, failed }))
    .sort((a, b) => b.failed - a.failed || a.errorCode - b.errorCode)
}

function typeFiguresOf(signIns: readonly SignIn[]): TypeFigures {
  const errorCodes = errorCodesOf(signIns)
  return {
    totals: totalsOf(signIns),
    errorCodeCount: errorCodes.length,
    applications: applicationsOf(signIns),
    errorCodes,
  }
}

export function figuresOf(signIns: readonly SignIn[]): DailyFigures {
  const figures = { all: typeFiguresOf(signIns) } as DailyFigures
  for (const type of SIGN_IN_TYPES) figures[type] = typeFiguresOf(signIns.filter((s) => s.signInEventType === type))
  return figures
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0)
}

/* Every way the stored figures must reconcile; empty when they do (AC-1 to AC-4). */
export function figuresViolations(figures: DailyFigures): string[] {
  const violations: string[] = []
  const missing = SIGN_IN_TYPE_FILTERS.filter((filter) => !figures[filter])
  if (missing.length > 0) return missing.map((filter) => `${filter}: figures are missing`)
  for (const filter of SIGN_IN_TYPE_FILTERS) {
    const f = figures[filter]
    const { total, successful, failed } = f.totals
    if (total !== successful + failed) violations.push(`${filter}: total is not successful plus failed`)
    if (sum(f.errorCodes, (e) => e.failed) !== failed) violations.push(`${filter}: error codes do not add up to failed`)
    if (f.errorCodeCount !== f.errorCodes.length)
      violations.push(`${filter}: error code count does not match the listed codes`)
    if (
      sum(f.applications, (a) => a.signIns) !== total ||
      sum(f.applications, (a) => a.successful) !== successful ||
      sum(f.applications, (a) => a.failed) !== failed
    )
      violations.push(`${filter}: applications do not add up to the tiles`)
  }
  for (const key of ['total', 'successful', 'failed'] as const) {
    if (sum(SIGN_IN_TYPES, (type) => figures[type].totals[key]) !== figures.all.totals[key])
      violations.push(`the four types do not add up to all types: ${key}`)
  }
  return violations
}
