import { describe, expect, it } from 'vitest'
import { hasAnyAccess, hasRole, rolesFromClaim } from '../src/roles.js'

describe('roles from the token claim', () => {
  it('keeps the known app roles once each, in a fixed order', () => {
    expect(rolesFromClaim(['config.write', 'reader', 'reader', 'offline_access', 7])).toEqual([
      'reader',
      'config.write',
    ])
  })

  it('treats a missing or malformed claim as no roles', () => {
    expect(rolesFromClaim(undefined)).toEqual([])
    expect(rolesFromClaim('reader')).toEqual([])
  })

  it('grants access to a reader or an administrator, and to no one else (AC-5)', () => {
    expect(hasAnyAccess(['reader'])).toBe(true)
    expect(hasAnyAccess(['config.read'])).toBe(true)
    expect(hasAnyAccess([])).toBe(false)
  })

  it('checks a single role', () => {
    expect(hasRole(['config.read'], 'reader')).toBe(false)
    expect(hasRole(['reader', 'config.read'], 'reader')).toBe(true)
  })
})
