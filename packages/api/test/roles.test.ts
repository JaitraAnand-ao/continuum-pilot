/* ST-1 AC-2, AC-3, AC-5, AC-7: who is a reader, an administrator, or neither. */
import { describe, expect, it } from 'vitest'
import { accessFor, canReadReports, isAdministrator, rolesFromClaim } from '../src/auth/roles.js'

describe('roles from the Keycloak roles claim', () => {
  it('keeps only the application roles, in a fixed order, without duplicates', () => {
    expect(rolesFromClaim(['offline_access', 'config.write', 'reader', 'reader'])).toEqual(['reader', 'config.write'])
  })

  it('treats a missing or malformed claim as no roles', () => {
    expect(rolesFromClaim(undefined)).toEqual([])
    expect(rolesFromClaim('reader')).toEqual([])
  })
})

describe('access', () => {
  it('a reader-only account is a reader and may read reports', () => {
    expect(accessFor(['reader'])).toBe('reader')
    expect(canReadReports(['reader'])).toBe(true)
    expect(isAdministrator(['reader'])).toBe(false)
  })

  it('an account holding reader and administrator claims is a reader and an administrator', () => {
    expect(accessFor(['reader', 'config.read'])).toBe('reader')
    expect(isAdministrator(['reader', 'config.read'])).toBe(true)
  })

  it.each([['config.read'], ['config.write'], ['config.approve']] as const)(
    'an administrator with only %s may not read reports',
    (role) => {
      expect(accessFor([role])).toBe('administrator')
      expect(canReadReports([role])).toBe(false)
    },
  )

  it('an account in neither group has no access', () => {
    expect(accessFor([])).toBe('none')
    expect(canReadReports([])).toBe(false)
  })
})
