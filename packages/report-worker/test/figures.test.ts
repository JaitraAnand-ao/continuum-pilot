import { describe, expect, it } from 'vitest'
import {
  figuresOf,
  figuresViolations,
  SIGN_IN_TYPE_FILTERS,
  SIGN_IN_TYPES,
  type DailyFigures,
  type SignIn,
  type SignInType,
} from '../src/index.js'
import { signIn } from './support.js'

const OTHER_ERROR_CODES = [50074, 50076, 50079, 50140, 50055, 50057, 50058, 70044, 16000] as const
const ERROR_CODES = [50126, 50053, 53003, ...OTHER_ERROR_CODES] as const

/* The AC-1 day: 184,312 sign-ins of which 7,408 failed across 12 distinct error codes, to 33 applications. */
function elevenOctober(): SignIn[] {
  const applications = [
    { appId: 'app-exchange', appDisplayName: 'Exchange Online' },
    { appId: 'app-workday', appDisplayName: 'Workday' },
    ...Array.from({ length: 31 }, (_, i) => ({ appId: `app-${i}`, appDisplayName: `Application ${i}` })),
  ]
  return Array.from({ length: 184_312 }, (_, i) =>
    signIn({
      id: `s-${i}`,
      signInEventType: SIGN_IN_TYPES[i % 3]!,
      errorCode: i < 7_408 ? ERROR_CODES[i % ERROR_CODES.length]! : 0,
      ...applications[i % applications.length]!,
    }),
  )
}

function only(signIns: readonly SignIn[], type: SignInType): SignIn[] {
  return signIns.filter((s) => s.signInEventType === type)
}

describe('AC-1: tiles reconcile to the stored snapshot', () => {
  const snapshot = elevenOctober()
  const figures = figuresOf(snapshot)

  it('Total sign-ins reads 184,312, Successful 176,904 and Failed 7,408 with 12 error codes', () => {
    expect(figures.all.totals).toEqual({ total: 184_312, successful: 176_904, failed: 7_408 })
    expect(figures.all.errorCodeCount).toBe(12)
    expect(figuresViolations(figures)).toEqual([])
  })

  it('counts errorCode 0 as successful and 1, the code one above it, as a failure', () => {
    const f = figuresOf([signIn({ id: 'a', errorCode: 0 }), signIn({ id: 'b', errorCode: 1 })])
    expect(f.all.totals).toEqual({ total: 2, successful: 1, failed: 1 })
    expect(f.all.errorCodes).toEqual([{ errorCode: 1, failed: 1 }])
    expect(f.all.errorCodeCount).toBe(1)
  })
})

describe('AC-2: per-application figures match the snapshot', () => {
  const snapshot = elevenOctober()
  const figures = figuresOf(snapshot)

  it('lists Exchange Online, Workday and 31 more applications, each equal to its snapshot count', () => {
    const rows = figures.all.applications
    expect(rows).toHaveLength(33)
    expect(rows.map((r) => r.appDisplayName)).toEqual(expect.arrayContaining(['Exchange Online', 'Workday']))
    for (const row of rows) {
      const ofApp = snapshot.filter((s) => s.appId === row.appId)
      const failed = ofApp.filter((s) => s.errorCode !== 0).length
      expect(row).toEqual({
        appId: row.appId,
        appDisplayName: ofApp[0]!.appDisplayName,
        signIns: ofApp.length,
        successful: ofApp.length - failed,
        failed,
      })
    }
    expect(rows.reduce((sum, r) => sum + r.signIns, 0)).toBe(figures.all.totals.total)
  })

  it('orders rows by sign-ins, highest first, then by name and id so the stored order never varies', () => {
    const f = figuresOf([
      signIn({ id: '1', appId: 'b', appDisplayName: 'Workday' }),
      signIn({ id: '2', appId: 'a', appDisplayName: 'Workday' }),
      signIn({ id: '3', appId: 'c', appDisplayName: 'Azure Portal' }),
      signIn({ id: '4', appId: 'd', appDisplayName: 'Teams' }),
      signIn({ id: '5', appId: 'd', appDisplayName: 'Teams', errorCode: 50126 }),
    ])
    expect(f.all.applications.map((r) => r.appId)).toEqual(['d', 'c', 'a', 'b'])
    expect(f.all.applications[0]).toEqual({
      appId: 'd',
      appDisplayName: 'Teams',
      signIns: 2,
      successful: 1,
      failed: 1,
    })
  })
})

describe('an application renamed during the day', () => {
  it('shows the name from its latest sign-in, whatever order Graph returned the pages in', () => {
    const renamed = [
      signIn({ id: '1', appId: 'app-hr', appDisplayName: 'HR Portal', createdDateTime: '2026-10-11T08:00:00.000Z' }),
      signIn({ id: '2', appId: 'app-hr', appDisplayName: 'Workday', createdDateTime: '2026-10-11T23:59:59.999Z' }),
      signIn({ id: '3', appId: 'app-hr', appDisplayName: 'Old HR', createdDateTime: '2026-10-11T00:00:00.000Z' }),
    ]
    const forward = figuresOf(renamed)
    expect(forward.all.applications).toEqual([
      { appId: 'app-hr', appDisplayName: 'Workday', signIns: 3, successful: 3, failed: 0 },
    ])
    expect(figuresOf([...renamed].reverse())).toEqual(forward)
  })

  it('breaks a tie between names at the same instant on the lower name', () => {
    const at = '2026-10-11T12:00:00.000Z'
    const tied = [
      signIn({ id: '1', appId: 'app-hr', appDisplayName: 'Workday', createdDateTime: at }),
      signIn({ id: '2', appId: 'app-hr', appDisplayName: 'HR Portal', createdDateTime: at }),
    ]
    expect(figuresOf(tied).all.applications[0]!.appDisplayName).toBe('HR Portal')
    expect(figuresOf([...tied].reverse())).toEqual(figuresOf(tied))
  })
})

describe('AC-3: failures by error code add up to the Failed tile', () => {
  const snapshot = elevenOctober()
  const figures = figuresOf(snapshot)

  it('lists 50126, 50053, 53003 and every other code with its failure count', () => {
    const codes = figures.all.errorCodes.map((e) => e.errorCode)
    expect(codes).toEqual(expect.arrayContaining([50126, 50053, 53003]))
    expect([...codes].sort()).toEqual([...ERROR_CODES].sort())
    for (const { errorCode, failed } of figures.all.errorCodes) {
      expect(failed).toBe(snapshot.filter((s) => s.errorCode === errorCode).length)
    }
    expect(figures.all.errorCodes.reduce((sum, e) => sum + e.failed, 0)).toBe(figures.all.totals.failed)
  })

  it('orders codes by count, highest first, then by code, and never lists a successful sign-in', () => {
    const f = figuresOf([
      signIn({ id: '1', errorCode: 53003 }),
      signIn({ id: '2', errorCode: 50053 }),
      signIn({ id: '3', errorCode: 50126 }),
      signIn({ id: '4', errorCode: 50126 }),
      signIn({ id: '5', errorCode: 0 }),
    ])
    expect(f.all.errorCodes).toEqual([
      { errorCode: 50126, failed: 2 },
      { errorCode: 50053, failed: 1 },
      { errorCode: 53003, failed: 1 },
    ])
  })
})

describe('AC-4: one sign-in type at a time', () => {
  const snapshot = SIGN_IN_TYPES.flatMap((type, t) =>
    Array.from({ length: (t + 1) * 3 }, (_, i) =>
      signIn({
        id: `${type}-${i}`,
        signInEventType: type,
        errorCode: i === 0 ? 50126 + t : 0,
        appId: `app-${type}`,
        appDisplayName: `App for ${type}`,
      }),
    ),
  )
  const figures = figuresOf(snapshot)

  it('offers All types and the four types, in the control order', () => {
    expect(SIGN_IN_TYPE_FILTERS).toEqual([
      'all',
      'interactiveUser',
      'nonInteractiveUser',
      'servicePrincipal',
      'managedIdentity',
    ])
    expect(Object.keys(figures)).toEqual([...SIGN_IN_TYPE_FILTERS])
  })

  it('Service principal shows only service principal sign-ins', () => {
    const sp = only(snapshot, 'servicePrincipal')
    expect(figures.servicePrincipal.totals).toEqual({ total: sp.length, successful: sp.length - 1, failed: 1 })
    expect(figures.servicePrincipal.applications.map((r) => r.appId)).toEqual(['app-servicePrincipal'])
    expect(figures.servicePrincipal.errorCodes).toEqual([{ errorCode: 50128, failed: 1 }])
    expect(figures.servicePrincipal).toEqual(figuresOf(sp).all)
  })

  it("the four types' totals add up to the All types total", () => {
    for (const key of ['total', 'successful', 'failed'] as const) {
      expect(SIGN_IN_TYPES.reduce((sum, type) => sum + figures[type].totals[key], 0)).toBe(figures.all.totals[key])
    }
    expect(figures.all.totals.total).toBe(snapshot.length)
    expect(figuresViolations(figures)).toEqual([])
  })
})

describe('AC-5: a sign-in type with no sign-ins that day', () => {
  it('Managed identity reads 0 in every tile and has no rows', () => {
    const figures = figuresOf([signIn({ id: 'a' }), signIn({ id: 'b', signInEventType: 'servicePrincipal' })])
    expect(figures.managedIdentity).toEqual({
      totals: { total: 0, successful: 0, failed: 0 },
      errorCodeCount: 0,
      applications: [],
      errorCodes: [],
    })
    expect(figuresViolations(figures)).toEqual([])
  })

  it('an empty snapshot is all zeros for every type', () => {
    const figures = figuresOf([])
    for (const filter of SIGN_IN_TYPE_FILTERS) expect(figures[filter].totals.total).toBe(0)
  })
})

describe('figures that do not reconcile are reported', () => {
  const base = figuresOf([
    signIn({ id: 'a', errorCode: 50126 }),
    signIn({ id: 'b', signInEventType: 'servicePrincipal', appId: 'app-sp', appDisplayName: 'Pipeline' }),
  ])

  function tampered(change: (f: DailyFigures) => void): DailyFigures {
    const copy = structuredClone(base) as DailyFigures
    change(copy)
    return copy
  }

  it('flags a total that is not successful plus failed', () => {
    const f = tampered((c) => (c.all.totals.total += 1))
    expect(figuresViolations(f)).toContain('all: total is not successful plus failed')
  })

  it('flags types that do not add up to All types', () => {
    const f = tampered((c) => (c.servicePrincipal.totals = { total: 2, successful: 2, failed: 0 }))
    expect(figuresViolations(f)).toContain('the four types do not add up to all types: total')
  })

  it('flags error codes that do not add up to Failed, and a wrong error code count', () => {
    const f = tampered((c) => {
      c.interactiveUser.errorCodes = [{ errorCode: 50126, failed: 2 }]
      c.interactiveUser.errorCodeCount = 3
    })
    expect(figuresViolations(f)).toEqual(
      expect.arrayContaining([
        'interactiveUser: error codes do not add up to failed',
        'interactiveUser: error code count does not match the listed codes',
      ]),
    )
  })

  it('flags applications that do not add up to the tiles', () => {
    const f = tampered((c) => (c.all.applications = c.all.applications.slice(1)))
    expect(figuresViolations(f)).toContain('all: applications do not add up to the tiles')
  })

  it('flags an application row whose successes and failures do not match the tiles', () => {
    const f = tampered((c) => {
      c.all.applications[0]!.successful += 1
      c.all.applications[0]!.failed -= 1
    })
    expect(figuresViolations(f)).toEqual(['all: applications do not add up to the tiles'])
  })

  it('flags a type whose successful or failed figure does not add up to All types', () => {
    const successful = tampered((c) => {
      c.all.totals.successful += 1
      c.all.totals.failed -= 1
    })
    expect(figuresViolations(successful)).toEqual(
      expect.arrayContaining([
        'the four types do not add up to all types: successful',
        'the four types do not add up to all types: failed',
      ]),
    )
    expect(figuresViolations(successful)).not.toContain('the four types do not add up to all types: total')
  })

  it('flags a single type whose total is not successful plus failed', () => {
    const f = tampered((c) => (c.servicePrincipal.totals.total += 1))
    expect(figuresViolations(f)).toContain('servicePrincipal: total is not successful plus failed')
  })

  it('flags a missing type', () => {
    const f = tampered((c) => delete (c as Partial<DailyFigures>).managedIdentity)
    expect(figuresViolations(f)).toContain('managedIdentity: figures are missing')
  })
})
