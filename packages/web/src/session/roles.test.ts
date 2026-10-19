import { describe, expect, it } from 'vitest'
import { loadContract } from '../test-support/contract'
import { ROLE_NAMES, navGroupsFor, roleNames } from './roles'

describe('navigation follows the /api/v1/me roles', () => {
  it('a reader sees only the REPORTS group: Daily report, Suspicious activity, Report history (AC-2)', () => {
    expect(navGroupsFor(['reader'])).toEqual([
      {
        label: 'REPORTS',
        items: [
          { label: 'Daily report', href: '/reports/daily' },
          { label: 'Suspicious activity', href: '/reports/suspicious' },
          { label: 'Report history', href: '/reports/history' },
        ],
      },
    ])
  })

  it('no group carries SETTINGS here, whatever the roles (ST-15 adds it)', () => {
    const labels = navGroupsFor(['reader', 'config.read', 'config.write', 'config.approve']).map((group) => group.label)
    expect(labels).toEqual(['REPORTS'])
  })

  it('an administrator without the reader role gets no REPORTS group', () => {
    expect(navGroupsFor(['config.read'])).toEqual([])
  })
})

describe('the top bar names the roles (AC-3)', () => {
  it.each([
    [['reader'], ['Reader']],
    [
      ['reader', 'config.read', 'config.approve'],
      ['Reader', 'Report administrator'],
    ],
    [['config.write'], ['Report administrator']],
    [[], []],
  ] as const)('%j -> %j', (roles, names) => {
    expect(roleNames(roles)).toEqual(names)
  })
})

describe('role names come from an explicit table keyed by the IF-4 role enum', () => {
  const roleSchema = loadContract('IF-4').responseSchema('/api/v1/me', 'get', 200, 'application/json') as {
    properties: { roles: { items: { enum: string[] } } }
  }

  it('names exactly the roles the contract enumerates', () => {
    expect(Object.keys(ROLE_NAMES).sort()).toEqual([...roleSchema.properties.roles.items.enum].sort())
    expect(ROLE_NAMES).toEqual({
      reader: 'Reader',
      'config.read': 'Report administrator',
      'config.write': 'Report administrator',
      'config.approve': 'Report administrator',
    })
  })

  it('names each role in the payload once, in payload order', () => {
    expect(roleNames(['config.approve', 'reader'])).toEqual(['Report administrator', 'Reader'])
  })
})
