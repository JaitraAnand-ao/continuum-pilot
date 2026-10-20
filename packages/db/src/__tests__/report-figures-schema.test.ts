import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { reportApplicationFigures, reportErrorCodeFigures, reportFigures, SIGN_IN_SCOPES } from '../schema.js'

const names = (items: { name: string }[]) => items.map((i) => i.name).sort()

describe('report figures schema (ST-3)', () => {
  it('names All types and the four sign-in types the type control offers (AC-4)', () => {
    expect(SIGN_IN_SCOPES).toEqual([
      'all',
      'interactiveUser',
      'nonInteractiveUser',
      'servicePrincipal',
      'managedIdentity',
    ])
  })

  it('stores the tiles once per report and sign-in type, every column required (AC-1, AC-5)', () => {
    const config = getTableConfig(reportFigures)
    expect(config.name).toBe('report_figures')
    expect(names(config.columns)).toEqual(
      ['error_code_count', 'failed', 'report_date', 'sign_in_type', 'successful', 'total'].sort(),
    )
    expect(config.columns.every((c) => c.notNull)).toBe(true)
    expect(config.primaryKeys[0]?.columns.map((c) => c.name)).toEqual(['report_date', 'sign_in_type'])
    expect(config.foreignKeys[0]?.reference().foreignTable).toBeDefined()
    expect(names(config.checks)).toEqual(
      [
        'report_figures_counts_non_negative',
        'report_figures_error_codes_within_failed',
        'report_figures_sign_in_type_known',
        'report_figures_total_is_successful_plus_failed',
      ].sort(),
    )
  })

  it('stores each application row per report and sign-in type (AC-2)', () => {
    const config = getTableConfig(reportApplicationFigures)
    expect(config.name).toBe('report_application_figures')
    expect(names(config.columns)).toEqual(
      ['app_display_name', 'app_id', 'failed', 'report_date', 'sign_in_type', 'successful', 'total'].sort(),
    )
    expect(config.columns.every((c) => c.notNull)).toBe(true)
    expect(config.primaryKeys[0]?.columns.map((c) => c.name)).toEqual(['report_date', 'sign_in_type', 'app_id'])
    expect(names(config.checks)).toEqual(
      [
        'report_application_figures_counts_non_negative',
        'report_application_figures_has_sign_ins',
        'report_application_figures_total_is_successful_plus_failed',
      ].sort(),
    )
  })

  it('stores each failing error code with its count per report and sign-in type (AC-3)', () => {
    const config = getTableConfig(reportErrorCodeFigures)
    expect(config.name).toBe('report_error_code_figures')
    expect(names(config.columns)).toEqual(['error_code', 'failed', 'report_date', 'sign_in_type'].sort())
    expect(config.columns.every((c) => c.notNull)).toBe(true)
    expect(config.primaryKeys[0]?.columns.map((c) => c.name)).toEqual(['report_date', 'sign_in_type', 'error_code'])
    expect(names(config.checks)).toEqual(
      ['report_error_code_figures_code_is_failure', 'report_error_code_figures_has_failures'].sort(),
    )
  })
})
