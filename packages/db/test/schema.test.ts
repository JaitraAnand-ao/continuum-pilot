/* ST-2 (CMP-5): the Drizzle schema for reports and their sign-in snapshots. */
import { describe, expect, it } from 'vitest'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { reports, reportStatus, signinSnapshots, signInType, signInTypes } from '../src/index.js'

const columns = (table: Parameters<typeof getTableConfig>[0]) =>
  Object.fromEntries(getTableConfig(table).columns.map((c) => [c.name, c]))

describe('reports', () => {
  const config = getTableConfig(reports)
  const cols = columns(reports)

  it('allows exactly one report per report date (AC-1, AC-4)', () => {
    const unique = config.indexes.filter((i) => i.config.unique)
    expect(unique.map((i) => i.config.columns.map((c) => ('name' in c ? c.name : '')))).toContainEqual(['report_date'])
  })

  it('holds the window, figures, hash, config version and publication time', () => {
    expect(cols['report_date']?.getSQLType()).toBe('date')
    expect(cols['window_start']?.getSQLType()).toBe('timestamp (3) with time zone')
    expect(cols['window_end']?.getSQLType()).toBe('timestamp (3) with time zone')
    for (const name of ['total_count', 'successful_count', 'failed_count']) {
      expect(cols[name]?.getSQLType()).toBe('integer')
      expect(cols[name]?.notNull).toBe(true)
    }
    expect(cols['content_hash']?.getSQLType()).toBe('char(64)')
    expect(cols['config_version_id']?.notNull).toBe(true)
    expect(cols['missing_sources']?.getSQLType()).toBe('text[]')
    expect(cols['published_at']?.notNull).toBe(false)
  })

  it('knows complete, incomplete and not generated, and nothing else (AC-5)', () => {
    expect(reportStatus.enumValues).toEqual(['complete', 'incomplete', 'not_generated'])
  })

  it('checks the window is the UTC day, the figures reconcile, and only a whole report is complete', () => {
    const checks = Object.fromEntries(config.checks.map((c) => [c.name, c]))
    expect(Object.keys(checks).sort()).toEqual([
      'reports_content_hash_is_sha256',
      'reports_counts_reconcile',
      'reports_status_matches_contents',
      'reports_window_is_the_utc_day',
    ])
  })
})

describe('signin_snapshots', () => {
  const config = getTableConfig(signinSnapshots)
  const cols = columns(signinSnapshots)

  it('stores the four sign-in types Graph reports (AC-2)', () => {
    expect(signInType.enumValues).toEqual([
      'interactiveUser',
      'nonInteractiveUser',
      'servicePrincipal',
      'managedIdentity',
    ])
    expect(signInTypes).toEqual(signInType.enumValues)
    expect(cols['sign_in_type']?.notNull).toBe(true)
  })

  it('carries CA policy results and device details on every row (AC-2)', () => {
    expect(cols['applied_conditional_access_policies']?.getSQLType()).toBe('jsonb')
    expect(cols['applied_conditional_access_policies']?.notNull).toBe(true)
    expect(cols['device_detail']?.getSQLType()).toBe('jsonb')
    expect(cols['device_detail']?.notNull).toBe(true)
    expect(cols['created_at']?.getSQLType()).toBe('timestamp (3) with time zone')
  })

  it('belongs to one report and holds each sign-in at most once per report (AC-3, AC-4)', () => {
    expect(config.primaryKeys[0]?.columns.map((c) => c.name)).toEqual(['report_id', 'sign_in_id'])
    const fk = config.foreignKeys[0]?.reference()
    expect(fk?.columns.map((c) => c.name)).toEqual(['report_id'])
    expect(fk?.foreignColumns.map((c) => c.name)).toEqual(['id'])
  })
})
