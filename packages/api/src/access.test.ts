import { describe, expect, it } from 'vitest'
import { decideAccess, rolesFromClaims } from './access.js'

describe('roles from the validated Keycloak ID token', () => {
  it('keeps only the known app roles, once each', () => {
    expect(rolesFromClaims({ roles: ['reader', 'offline_access', 'reader', 'config.approve'] })).toEqual([
      'reader',
      'config.approve',
    ])
  })

  it('treats a missing or malformed roles claim as no roles', () => {
    expect(rolesFromClaims({})).toEqual([])
    expect(rolesFromClaims({ roles: 'reader' })).toEqual([])
    expect(rolesFromClaims({ roles: [42, null] })).toEqual([])
  })
})

describe('AC-5 and AC-7 access decisions (AD-7)', () => {
  it('lets anyone reach a public route', () => {
    expect(decideAccess(null, 'public')).toBe('allow')
  })

  it('answers unauthenticated without a session', () => {
    expect(decideAccess(null, 'signed-in')).toBe('unauthenticated')
    expect(decideAccess(null, 'reader')).toBe('unauthenticated')
  })

  it('answers no-access for an account in neither the reader nor the administrator group', () => {
    expect(decideAccess([], 'signed-in')).toBe('no-access')
    expect(decideAccess([], 'reader')).toBe('no-access')
  })

  it('lets a reader or an administrator reach a signed-in route', () => {
    expect(decideAccess(['reader'], 'signed-in')).toBe('allow')
    expect(decideAccess(['config.read'], 'signed-in')).toBe('allow')
  })

  it('forbids a report route to an administrator without the reader role', () => {
    expect(decideAccess(['config.read', 'config.write', 'config.approve'], 'reader')).toBe('forbidden')
    expect(decideAccess(['reader', 'config.read'], 'reader')).toBe('allow')
  })
})
