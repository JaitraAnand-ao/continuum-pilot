/* Which claims open the dashboard (ST-1 AC-2, AC-3, AC-5). */
import { describe, expect, it } from 'vitest'
import { hasAnyAccess, rolesFromClaim } from '../src/auth/roles.js'

describe('rolesFromClaim', () => {
  it('keeps only the known roles, once each, in a stable order', () => {
    expect(rolesFromClaim(['config.write', 'offline_access', 'reader', 'reader', 'uma_authorization'])).toEqual([
      'reader',
      'config.write',
    ])
  })

  it('gives no roles for a missing or malformed claim', () => {
    expect(rolesFromClaim(undefined)).toEqual([])
    expect(rolesFromClaim('reader')).toEqual([])
    expect(rolesFromClaim([1, null, { role: 'reader' }])).toEqual([])
  })
})

describe('hasAnyAccess', () => {
  it('opens the dashboard to the reader group and to report administrators, and to nobody else', () => {
    expect(hasAnyAccess(['reader'])).toBe(true)
    expect(hasAnyAccess(['config.read'])).toBe(true)
    expect(hasAnyAccess(['reader', 'config.read', 'config.write', 'config.approve'])).toBe(true)
    expect(hasAnyAccess([])).toBe(false)
  })
})
