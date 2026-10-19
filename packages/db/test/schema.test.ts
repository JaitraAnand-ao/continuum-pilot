import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { REPORT_SOURCES, REPORT_STATUSES, report, reportNotGenerated, SIGN_IN_TYPES } from '../src/index.js'

describe('report schema', () => {
  it('names the four sign-in types and the five sources a report can miss', () => {
    expect(SIGN_IN_TYPES).toEqual(['interactiveUser', 'nonInteractiveUser', 'servicePrincipal', 'managedIdentity'])
    expect(REPORT_SOURCES).toEqual([
      ...SIGN_IN_TYPES.map((type) => `signIns.${type}`),
      'identityProtection.riskDetections',
    ])
    expect(REPORT_STATUSES).toEqual(['complete', 'incomplete'])
  })

  it('keys one report and one not-generated record on the report date', () => {
    const reportTable = getTableConfig(report)
    expect(reportTable.name).toBe('report')
    expect(reportTable.columns.map((c) => c.name)).toEqual([
      'report_date',
      'window_start',
      'window_end',
      'status',
      'missing_sources',
      'total',
      'successful',
      'failed',
      'snapshot',
      'content_hash',
      'published_at',
    ])
    expect(reportTable.columns.find((c) => c.primary)?.name).toBe('report_date')

    const notGenerated = getTableConfig(reportNotGenerated)
    expect(notGenerated.name).toBe('report_not_generated')
    expect(notGenerated.columns.map((c) => c.name)).toEqual(['report_date', 'missing_sources', 'recorded_at'])
    expect(notGenerated.columns.find((c) => c.primary)?.name).toBe('report_date')
  })
})
