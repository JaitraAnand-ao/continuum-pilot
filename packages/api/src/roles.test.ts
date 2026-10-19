import { describe, expect, it } from 'vitest'
import { ADMIN_APP_ROLE, READER_APP_ROLE, hasAnyAccess, rolesFromClaims } from './roles'

describe('rolesFromClaims', () => {
  it('maps the reader app role to reader only', () => {
    expect(rolesFromClaims({ roles: [READER_APP_ROLE] })).toEqual(['reader'])
  })

  it('maps the report administrator app role to the config roles', () => {
    expect(rolesFromClaims({ roles: [ADMIN_APP_ROLE] })).toEqual(['config.read', 'config.write', 'config.approve'])
  })

  it('grants both when both claims are held, without duplicates', () => {
    expect(rolesFromClaims({ roles: [ADMIN_APP_ROLE, READER_APP_ROLE, READER_APP_ROLE] })).toEqual([
      'reader',
      'config.read',
      'config.write',
      'config.approve',
    ])
  })

  it('grants nothing for unknown, missing or malformed role claims', () => {
    expect(rolesFromClaims({ roles: ['Something.Else'] })).toEqual([])
    expect(rolesFromClaims({})).toEqual([])
    expect(rolesFromClaims({ roles: 'SignInReports.Reader' })).toEqual([])
    expect(rolesFromClaims({ roles: [42] })).toEqual([])
  })

  it('treats an empty role set as no access', () => {
    expect(hasAnyAccess([])).toBe(false)
    expect(hasAnyAccess(['reader'])).toBe(true)
    expect(hasAnyAccess(['config.read'])).toBe(true)
  })
})
