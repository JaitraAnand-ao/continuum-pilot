import { describe, expect, it } from 'vitest'
import { navigationFor, roleNames } from './roles'

describe('navigationFor follows the roles from /api/v1/me', () => {
  it('a reader sees only the REPORTS group: Daily report, Suspicious activity, Report history', () => {
    expect(navigationFor(['reader'])).toEqual([
      {
        label: 'REPORTS',
        items: [
          { route: 'daily', label: 'Daily report', path: '/reports/daily' },
          { route: 'suspicious', label: 'Suspicious activity', path: '/reports/suspicious' },
          { route: 'history', label: 'Report history', path: '/reports/history' },
        ],
      },
    ])
  })

  it('holding the administrator claims adds no SETTINGS group here (ST-15 delivers it)', () => {
    const groups = navigationFor(['reader', 'config.read', 'config.write', 'config.approve'])
    expect(groups.map((group) => group.label)).toEqual(['REPORTS'])
  })

  it('an administrator without the reader role gets no REPORTS group', () => {
    expect(navigationFor(['config.read'])).toEqual([])
  })
})

describe('roleNames names the roles on the top bar', () => {
  it('names a reader', () => {
    expect(roleNames(['reader'])).toEqual(['Reader'])
  })

  it('names both roles for someone holding the reader and administrator claims', () => {
    expect(roleNames(['reader', 'config.read', 'config.write'])).toEqual(['Reader', 'Report administrator'])
  })

  it('names an administrator once whichever config claims they hold', () => {
    expect(roleNames(['config.approve'])).toEqual(['Report administrator'])
    expect(roleNames([])).toEqual([])
  })
})
