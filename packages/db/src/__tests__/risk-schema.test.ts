import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import {
  CONDITIONAL_ACCESS_STATUSES,
  FLAGGED_RISK_STATES,
  IDENTITY_PROTECTION_SOURCES,
  REPORT_SOURCES,
  RISK_TRIGGER_LEVELS,
  reportRiskySignInFlags,
  reportRiskyUserFlags,
  reports,
} from '../schema.js'

const columns = (table: Parameters<typeof getTableConfig>[0]) =>
  Object.fromEntries(getTableConfig(table).columns.map((c) => [c.name, c.notNull]))

describe('risk flag schema (ST-9)', () => {
  it('names both Identity Protection collections as report sources (AC-1, AC-7)', () => {
    expect(IDENTITY_PROTECTION_SOURCES).toEqual(['identityProtection.riskDetections', 'identityProtection.riskyUsers'])
    for (const source of IDENTITY_PROTECTION_SOURCES) expect(REPORT_SOURCES).toContain(source)
  })

  it('names the trigger levels, the flagged risk states and the Conditional Access results', () => {
    expect(RISK_TRIGGER_LEVELS).toEqual(['medium', 'high'])
    expect(FLAGGED_RISK_STATES).toEqual(['atRisk', 'confirmedCompromised'])
    expect(CONDITIONAL_ACCESS_STATUSES).toEqual(['success', 'failure', 'notApplied', 'unknownFutureValue'])
  })

  it('stores the risky counts on the report as nullable, so not evaluated is never a quiet zero (AC-7)', () => {
    const report = columns(reports)
    expect(report['risky_sign_ins']).toBe(false)
    expect(report['risky_users']).toBe(false)
    expect(getTableConfig(reports).checks.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'report_risky_counts_evaluated_together',
        'report_risky_counts_non_negative',
        'report_risky_not_evaluated_without_identity_protection',
        'report_risky_snapshot_holds_risk_data',
      ]),
    )
  })

  it('stores each risky sign-in flag with its trigger, observed level and evidence; blanks are nullable (AC-4, AC-6)', () => {
    const config = getTableConfig(reportRiskySignInFlags)
    expect(config.name).toBe('report_risky_sign_in_flag')
    expect(columns(reportRiskySignInFlags)).toEqual({
      report_date: true,
      request_id: true,
      trigger_level: true,
      observed_risk_level: true,
      signed_in_at: true,
      user_id: false,
      user_principal_name: false,
      app_id: false,
      app_display_name: false,
      ip_address: false,
      location: false,
      device_compliant: false,
      conditional_access_status: false,
    })
    expect(config.primaryKeys[0]!.columns.map((c) => c.name)).toEqual(['report_date', 'request_id'])
    expect(config.foreignKeys).toHaveLength(1)
    expect(config.checks.map((c) => c.name).sort()).toEqual(
      [
        'report_risky_sign_in_flag_blank_is_not_recorded',
        'report_risky_sign_in_flag_conditional_access_known',
        'report_risky_sign_in_flag_observed_meets_trigger',
        'report_risky_sign_in_flag_request_id_present',
        'report_risky_sign_in_flag_signed_in_within_day',
      ].sort(),
    )
  })

  it('stores each risky user flag with its state, level, detections and sign-in IDs (AC-5, AC-6)', () => {
    const config = getTableConfig(reportRiskyUserFlags)
    expect(config.name).toBe('report_risky_user_flag')
    expect(columns(reportRiskyUserFlags)).toEqual({
      report_date: true,
      user_id: true,
      user_principal_name: false,
      user_display_name: false,
      trigger_level: true,
      risk_state: true,
      risk_level: true,
      detections: true,
      sign_in_ids: true,
    })
    expect(config.primaryKeys[0]!.columns.map((c) => c.name)).toEqual(['report_date', 'user_id'])
    expect(config.foreignKeys).toHaveLength(1)
    expect(config.indexes.map((i) => i.config.name)).toEqual(['report_risky_user_flag_user_id_idx'])
    expect(config.checks.map((c) => c.name).sort()).toEqual(
      [
        'report_risky_user_flag_blank_is_not_recorded',
        'report_risky_user_flag_detections_complete',
        'report_risky_user_flag_level_meets_trigger',
        'report_risky_user_flag_sign_in_ids_present',
        'report_risky_user_flag_state_flagged',
        'report_risky_user_flag_user_id_present',
      ].sort(),
    )
  })
})
