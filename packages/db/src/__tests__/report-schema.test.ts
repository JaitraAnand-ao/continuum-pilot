import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { REPORT_SOURCES, REPORT_STATUSES, reportNotGenerated, reports } from '../schema.js'

describe('report schema (ST-2)', () => {
  it('stores one report per date with its window, outcome, figures, snapshot and hash', () => {
    const config = getTableConfig(reports)
    expect(config.name).toBe('report')
    expect(config.columns.map((c) => c.name).sort()).toEqual(
      [
        'content_hash',
        'failed',
        'missing_sources',
        'published_at',
        'report_date',
        'risky_sign_ins',
        'risky_users',
        'snapshot',
        'status',
        'successful',
        'total',
        'window_end',
        'window_start',
      ].sort(),
    )
    expect(config.columns.filter((c) => c.primary).map((c) => c.name)).toEqual(['report_date'])
    /* Only the ST-9 risk counts may be NULL: not evaluated. */
    expect(config.columns.filter((c) => !c.notNull).map((c) => c.name)).toEqual(['risky_sign_ins', 'risky_users'])
  })

  it('guards the window, the outcome, the figures and the hash with CHECK constraints', () => {
    expect(
      getTableConfig(reports)
        .checks.map((c) => c.name)
        .sort(),
    ).toEqual(
      [
        'report_content_hash_sha256',
        'report_counts_non_negative',
        'report_missing_sources_known',
        'report_published_after_window',
        'report_risky_counts_evaluated_together',
        'report_risky_counts_non_negative',
        'report_risky_not_evaluated_without_identity_protection',
        'report_risky_snapshot_holds_risk_data',
        'report_status_known',
        'report_status_matches_missing_sources',
        'report_total_is_successful_plus_failed',
        'report_total_matches_snapshot',
        'report_window_is_utc_day',
      ].sort(),
    )
  })

  it('records a not-generated day with the sources that could not be collected', () => {
    const config = getTableConfig(reportNotGenerated)
    expect(config.name).toBe('report_not_generated')
    expect(config.columns.map((c) => c.name).sort()).toEqual(['missing_sources', 'recorded_at', 'report_date'])
    expect(config.checks.map((c) => c.name).sort()).toEqual([
      'report_not_generated_missing_sources_known',
      'report_not_generated_missing_sources_present',
    ])
  })

  it('names the four sign-in sources and the two Identity Protection collections, and the two published statuses', () => {
    expect(REPORT_SOURCES).toEqual([
      'signIns.interactiveUser',
      'signIns.nonInteractiveUser',
      'signIns.servicePrincipal',
      'signIns.managedIdentity',
      'identityProtection.riskDetections',
      'identityProtection.riskyUsers',
    ])
    expect(REPORT_STATUSES).toEqual(['complete', 'incomplete'])
  })
})
