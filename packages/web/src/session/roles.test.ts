import { describe, expect, it } from 'vitest'
import { navGroupsFor, roleNames } from './roles'

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
