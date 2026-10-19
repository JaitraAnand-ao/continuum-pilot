import { describe, expect, it } from 'vitest'
import { navGroups, roleLabels, screenFor } from '../src/session/roles'

describe('navigation follows the roles from /api/v1/me', () => {
  it('AC-2: a reader sees only the REPORTS group with its three screens', () => {
    expect(navGroups(['reader'])).toEqual([
      {
        label: 'REPORTS',
        items: [
          { screen: 'daily', label: 'Daily report', href: '/reports/daily' },
          { screen: 'suspicious', label: 'Suspicious activity', href: '/reports/suspicious' },
          { screen: 'history', label: 'Report history', href: '/reports/history' },
        ],
      },
    ])
  })

  it('shows no SETTINGS group here, even with both claims (ST-15 delivers it)', () => {
    expect(navGroups(['reader', 'config.read', 'config.write']).map((group) => group.label)).toEqual(['REPORTS'])
  })

  it('shows no REPORTS group to an administrator without the reader role', () => {
    expect(navGroups(['config.read'])).toEqual([])
  })
})

describe('role names on the top bar', () => {
  it('AC-3: names both roles for a reader who is also an administrator', () => {
    expect(roleLabels(['reader', 'config.read', 'config.approve'])).toEqual(['Reader', 'Report administrator'])
  })

  it('names one role when only one is held', () => {
    expect(roleLabels(['reader'])).toEqual(['Reader'])
    expect(roleLabels(['config.write'])).toEqual(['Report administrator'])
  })
})

describe('landing screen', () => {
  it('AC-2, AC-3: readers land on the Daily report', () => {
    expect(screenFor('/', ['reader'])).toBe('daily')
    expect(screenFor('/', ['reader', 'config.read'])).toBe('daily')
    expect(screenFor('/somewhere', ['reader'])).toBe('daily')
  })

  it('keeps a reader on the report screen they opened', () => {
    expect(screenFor('/reports/suspicious', ['reader'])).toBe('suspicious')
    expect(screenFor('/reports/history', ['reader'])).toBe('history')
  })

  it('sends an administrator-only account to Detection settings', () => {
    expect(screenFor('/reports/daily', ['config.read'])).toBe('settings')
  })
})
