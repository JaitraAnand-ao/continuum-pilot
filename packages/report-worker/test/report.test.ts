import { describe, expect, it } from 'vitest'
import {
  buildReportContent,
  computeTotals,
  contentHash,
  decideOutcome,
  reportWindow,
  SIGN_IN_EVENT_TYPES,
  SOURCE_LABELS,
  type SourceResults,
} from '../src/index.js'
import { signIn } from './support/fakes.js'

const window = reportWindow('2026-10-11')

function allCollected(overrides: Partial<SourceResults> = {}): SourceResults {
  return {
    interactiveUser: { ok: true, items: [] },
    nonInteractiveUser: { ok: true, items: [] },
    servicePrincipal: { ok: true, items: [] },
    managedIdentity: { ok: true, items: [] },
    identityProtection: { ok: true, items: { riskDetections: [], riskyUsers: [] } },
    ...overrides,
  }
}

describe('totals reconcile to the snapshot', () => {
  it('counts error code 0 as successful and anything else as failed, per type and overall', () => {
    const totals = computeTotals([
      signIn('a', '2026-10-11T01:00:00Z', 'interactiveUser', 0),
      signIn('b', '2026-10-11T02:00:00Z', 'interactiveUser', 50126),
      signIn('c', '2026-10-11T03:00:00Z', 'servicePrincipal', 0),
      signIn('d', '2026-10-11T04:00:00Z', 'managedIdentity', 1),
    ])
    expect(totals).toEqual({
      total: 4,
      successful: 2,
      failed: 2,
      byEventType: {
        interactiveUser: { total: 2, successful: 1, failed: 1 },
        nonInteractiveUser: { total: 0, successful: 0, failed: 0 },
        servicePrincipal: { total: 1, successful: 1, failed: 0 },
        managedIdentity: { total: 1, successful: 0, failed: 1 },
      },
    })
  })

  it('gives zeros for a day without sign-ins (AC-7)', () => {
    const totals = computeTotals([])
    expect([totals.total, totals.successful, totals.failed]).toEqual([0, 0, 0])
  })
})

describe('outcome of a collection (AC-5)', () => {
  it('is complete when every source was collected', () => {
    expect(decideOutcome(allCollected())).toEqual({ kind: 'publish', completeness: 'complete', missingSources: [] })
  })

  it('is incomplete and names Identity Protection when only it failed', () => {
    expect(decideOutcome(allCollected({ identityProtection: { ok: false, reason: 'deadline' } }))).toEqual({
      kind: 'publish',
      completeness: 'incomplete',
      missingSources: ['identityProtection'],
    })
    expect(SOURCE_LABELS.identityProtection).toBe('Identity Protection risk data')
  })

  it('is incomplete when one sign-in type failed but another was collected', () => {
    expect(
      decideOutcome(
        allCollected({
          interactiveUser: { ok: false, reason: 'x' },
          nonInteractiveUser: { ok: false, reason: 'x' },
          servicePrincipal: { ok: false, reason: 'x' },
        }),
      ),
    ).toEqual({
      kind: 'publish',
      completeness: 'incomplete',
      missingSources: ['interactiveUser', 'nonInteractiveUser', 'servicePrincipal'],
    })
  })

  it('is not generated when no sign-in source at all was collected', () => {
    const failed = { ok: false as const, reason: 'x' }
    const noSignIns = allCollected(Object.fromEntries(SIGN_IN_EVENT_TYPES.map((t) => [t, failed])))
    expect(decideOutcome(noSignIns)).toEqual({
      kind: 'not-generated',
      missingSources: [...SIGN_IN_EVENT_TYPES],
    })
    expect(decideOutcome({ ...noSignIns, identityProtection: failed })).toEqual({
      kind: 'not-generated',
      missingSources: [...SIGN_IN_EVENT_TYPES, 'identityProtection'],
    })
  })
})

describe('report content', () => {
  const results = allCollected({
    interactiveUser: {
      ok: true,
      items: [
        signIn('late', '2026-10-11T23:59:59.999Z', 'interactiveUser'),
        signIn('next-day', '2026-10-12T00:00:00.000Z', 'interactiveUser'),
        signIn('early', '2026-10-11T00:00:00.000Z', 'interactiveUser', 50126),
        signIn('early', '2026-10-11T00:00:00.000Z', 'interactiveUser', 50126),
      ],
    },
    identityProtection: {
      ok: true,
      items: { riskDetections: [{ id: 'rd-1', riskLevel: 'high' }], riskyUsers: [{ id: 'ru-1', riskLevel: 'low' }] },
    },
  })

  it('keeps only sign-ins inside the window, once each, ordered by time, with totals from that snapshot', () => {
    const content = buildReportContent(window, results, decideOutcome(results))
    expect(content.snapshot.signIns.map((s) => s.id)).toEqual(['early', 'late'])
    expect(content.totals.total).toBe(content.snapshot.signIns.length)
    expect(content.totals).toMatchObject({ total: 2, successful: 1, failed: 1 })
    expect(content.snapshot.riskDetections).toEqual([{ id: 'rd-1', riskLevel: 'high' }])
    expect(content.snapshot.riskyUsers).toEqual([{ id: 'ru-1', riskLevel: 'low' }])
    expect(content).toMatchObject({
      reportDate: '2026-10-11',
      window: { start: '2026-10-11T00:00:00Z', end: '2026-10-12T00:00:00Z' },
      completeness: 'complete',
      missingSources: [],
      missingSourceLabels: [],
    })
  })

  it('names missing sources by label and stores empty data for them', () => {
    const partial = allCollected({ identityProtection: { ok: false, reason: 'deadline' } })
    const content = buildReportContent(window, partial, decideOutcome(partial))
    expect(content.completeness).toBe('incomplete')
    expect(content.missingSourceLabels).toEqual(['Identity Protection risk data'])
    expect(content.snapshot.riskDetections).toEqual([])
  })

  it('refuses to build content for a day that is not generated', () => {
    const failed = { ok: false as const, reason: 'x' }
    const none = allCollected(Object.fromEntries(SIGN_IN_EVENT_TYPES.map((t) => [t, failed])))
    expect(() => buildReportContent(window, none, decideOutcome(none))).toThrow()
  })

  it('hashes content canonically: same content, same hash; any change, another hash', () => {
    const content = buildReportContent(window, results, decideOutcome(results))
    const reordered = Object.fromEntries(Object.entries(content).reverse()) as typeof content
    expect(contentHash(content)).toMatch(/^[0-9a-f]{64}$/)
    expect(contentHash(reordered)).toBe(contentHash(content))
    expect(contentHash({ ...content, totals: { ...content.totals, failed: 2 } })).not.toBe(contentHash(content))
  })
})
