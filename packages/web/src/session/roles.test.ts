import { describe, expect, it } from 'vitest'
import { navigationFor, REPORTS_GROUP, roleNames } from './roles'
import { NOT_AVAILABLE, pageFor, pageTitle } from './routes'

describe('navigation follows the roles from /api/v1/me', () => {
  it('a reader sees only the REPORTS group: Daily report, Suspicious activity, Report history (AC-2)', () => {
    const groups = navigationFor(['reader'])
    expect(groups.map((group) => group.label)).toEqual(['REPORTS'])
    expect(groups[0]?.items.map((item) => item.label)).toEqual([
      'Daily report',
      'Suspicious activity',
      'Report history',
    ])
  })

  it('a reader who is also an administrator still sees no SETTINGS group here (delivered by ST-15)', () => {
    expect(navigationFor(['reader', 'config.read', 'config.write', 'config.approve'])).toEqual([REPORTS_GROUP])
  })

  it('an administrator without the reader role gets no REPORTS group', () => {
    expect(navigationFor(['config.read'])).toEqual([])
  })
})

describe('role names on the top bar', () => {
  it('names the reader role', () => {
    expect(roleNames(['reader'])).toEqual(['Reader'])
  })

  it('names both roles for an account holding both claims (AC-3)', () => {
    expect(roleNames(['config.approve', 'reader'])).toEqual(['Reader', 'Report administrator'])
  })

  it('names the administrator once however many config roles it holds', () => {
    expect(roleNames(['config.read', 'config.write'])).toEqual(['Report administrator'])
  })

  it('names nothing for no roles', () => {
    expect(roleNames([])).toEqual([])
  })
})

describe('pages', () => {
  it('report paths are reader pages headed by their navigation label', () => {
    expect(pageFor('/reports/history')).toEqual({
      path: '/reports/history',
      heading: 'Report history',
      requiresReader: true,
    })
  })

  it('an unknown path is not available', () => {
    expect(pageFor('/nowhere')).toEqual({ ...NOT_AVAILABLE, path: '/nowhere' })
  })

  it('titles end with the application name', () => {
    expect(pageTitle('No access')).toBe('No access – Entra Sign-In Reports')
  })
})
