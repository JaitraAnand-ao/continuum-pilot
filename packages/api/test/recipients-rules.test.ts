/* The reader-group rule for daily-email recipients (ST-18 AC-1 to AC-4, AC-6), each boundary tested at and one below. */
import { describe, expect, it } from 'vitest'
import {
  actionLabel,
  assessGroup,
  assessPerson,
  checkText,
  messages,
  statusText,
  typeText,
} from '../src/recipients/rules.js'

const member = (id: string) => ({ id, address: `${id}@contoso.com` })

describe('assessPerson', () => {
  it('passes a person the directory reports as a (direct or nested) reader', () => {
    expect(assessPerson('u-dchen', new Set(['u-dchen']))).toEqual({ verdict: 'eligible', memberCount: null })
  })

  it('rejects a person outside the reader group', () => {
    expect(assessPerson('u-mvance', new Set(['u-dchen']))).toEqual({ verdict: 'not-reader' })
    expect(assessPerson('u-mvance', new Set())).toEqual({ verdict: 'not-reader' })
  })
})

describe('assessGroup', () => {
  it('accepts a group whose every member is a reader', () => {
    expect(assessGroup([member('a'), member('b')], new Set(['a', 'b']))).toEqual({
      verdict: 'eligible',
      memberCount: 2,
    })
  })

  it('rejects a group with exactly one outsider, naming that address', () => {
    expect(assessGroup([member('a'), member('b')], new Set(['a']))).toEqual({
      verdict: 'group-outsiders',
      memberCount: 2,
      outsiders: ['b@contoso.com'],
    })
  })

  it('reports the count of outsiders among the total, addresses sorted', () => {
    const members = Array.from({ length: 240 }, (_, index) => member(`u${String(index).padStart(3, '0')}`))
    const outsiders = new Set(['u239', 'u007', 'u120'])
    const readers = new Set(members.map((one) => one.id).filter((id) => !outsiders.has(id)))
    expect(assessGroup(members, readers)).toEqual({
      verdict: 'group-outsiders',
      memberCount: 240,
      outsiders: ['u007@contoso.com', 'u120@contoso.com', 'u239@contoso.com'],
    })
  })

  it('counts a person reached through two nested groups once', () => {
    expect(assessGroup([member('a'), member('a'), member('b')], new Set(['a', 'b']))).toEqual({
      verdict: 'eligible',
      memberCount: 2,
    })
  })

  it('accepts a group of one reader and rejects a group of none', () => {
    expect(assessGroup([member('a')], new Set(['a']))).toEqual({ verdict: 'eligible', memberCount: 1 })
    expect(assessGroup([], new Set(['a']))).toEqual({ verdict: 'empty-group' })
  })
})

describe('the words on the Email recipients screen', () => {
  it('describes type and check result in text', () => {
    expect(typeText('person', null)).toBe('Person')
    expect(typeText('group', 5)).toBe('Group with 5 members')
    expect(typeText('group', 1)).toBe('Group with 1 member')
    expect(typeText('group', null)).toBe('Group with 0 members')
    expect(checkText('group', null)).toBe('All 0 members')
    expect(checkText('person', null)).toBe('In the reader group')
    expect(checkText('group', 5)).toBe('All 5 members')
    expect(checkText('group', 2)).toBe('All 2 members')
    expect(checkText('group', 1)).toBe('Its 1 member')
  })

  it('names the status and the action for the recipient', () => {
    expect(statusText('active')).toBe('Active')
    expect(statusText('pending')).toBe('Waiting for approval')
    expect(actionLabel('active', 'SOC team', 'soc@contoso.com')).toBe('Remove SOC team, soc@contoso.com')
    expect(actionLabel('pending', 'd.chen', 'd.chen@contoso.com')).toBe('Withdraw d.chen, d.chen@contoso.com')
  })

  it('announces outcomes in the words of the story', () => {
    expect(messages.passed('d.chen')).toBe('d.chen passed the check and was sent for approval; no email until approved')
    expect(messages.notReader('m.vance')).toBe(
      "m.vance isn't in the reader group, so they can't receive reports. Ask your Entra administrator to add them first.",
    )
    expect(messages.outsiders('it-all', 3, 240)).toBe('it-all has 3 of 240 members outside the reader group')
    expect(messages.outsiders('pair', 1, 2)).toBe('pair has 1 of 2 members outside the reader group')
    expect(messages.emptyGroup('nobody')).toBe('nobody has no members, so nobody would receive the email.')
    expect(messages.removed('SOC team')).toBe("SOC team removed. They won't get tomorrow's email")
    expect(messages.removeConfirmation).toBe("They won't get tomorrow's email")
    expect(messages.withdrawn('d.chen')).toBe('d.chen withdrawn. No approval is needed now')
    expect(messages.checkFailed('d.chen')).toBe(
      "Couldn't check the reader group, so d.chen wasn't added. Try again later.",
    )
    expect(messages.checkFailed(undefined)).toBe(
      "Couldn't check the reader group, so the recipient wasn't added. Try again later.",
    )
    expect(messages.saveFailed).toBe("Couldn't save. The recipient list is unchanged.")
    expect(messages.nobody).toBe('Nobody receives the daily email')
    expect(messages.stillGenerated).toBe('Reports are still generated in the dashboard.')
    expect(messages.adminOnly).toBe('Only report administrators can manage recipients.')
  })
})
