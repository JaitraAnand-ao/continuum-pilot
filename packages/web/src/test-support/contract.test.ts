import { describe, expect, it } from 'vitest'
import { isMe, isProblem } from '../api/client'
import { loadContract, validate } from './contract'
import { adminOnlyMe, noAccessProblem, readerAdminMe, readerMe, unauthenticatedProblem } from './fixtures'

const if4 = loadContract('IF-4')
const me200 = if4.responseSchema('/api/v1/me', 'get', 200, 'application/json')
const me401 = if4.responseSchema('/api/v1/me', 'get', 401, 'application/problem+json')
const me403 = if4.responseSchema('/api/v1/me', 'get', 403, 'application/problem+json')

describe('IF-4 fixtures honour contracts/IF-4.json', () => {
  it.each([
    ['reader', readerMe],
    ['reader and administrator', readerAdminMe],
    ['administrator only', adminOnlyMe],
  ])('the %s 200 body is valid', (_name, body) => {
    expect(validate(body, me200)).toEqual([])
    expect(isMe(body)).toBe(true)
  })

  it('the 401 problem is valid', () => {
    expect(validate(unauthenticatedProblem, me401)).toEqual([])
  })

  it('the 403 no-access problem is valid, title naming the UPN', () => {
    expect(validate(noAccessProblem, me403)).toEqual([])
    expect(isProblem(noAccessProblem)).toBe(true)
  })
})

describe('the contract validator rejects what the contract forbids', () => {
  it('flags a missing field, an extra field, an unknown role and duplicate roles', () => {
    const rest: Partial<typeof readerMe> = { ...readerMe }
    delete rest.authTime
    expect(validate({ ...rest, roles: ['reader', 'reader', 'owner'], token: 'x' }, me200)).toEqual([
      '$.authTime is required',
      '$.roles must hold unique items',
      '$.roles[2] is not in the enum',
      '$.token is not allowed',
    ])
  })

  it('flags wrong types, a bad date-time, a const mismatch and a pattern mismatch', () => {
    expect(validate([], me200)).toEqual(['$ must be an object'])
    expect(validate({ ...readerMe, roles: 'reader', idleExpiresAt: 'soon', account: 7 }, me200)).toEqual([
      '$.account must be a string',
      '$.roles must be an array',
      '$.idleExpiresAt must be a date-time',
    ])
    expect(validate({ ...noAccessProblem, status: 401.5, title: 'Nope' }, me403)).toEqual([
      '$.title does not match ' + "^You don't have access\\. Signed in as \\S+@\\S+\\.$",
      '$.status must equal 403',
      '$.status must be an integer',
    ])
  })

  it('refuses a response the contract does not document', () => {
    expect(() => if4.responseSchema('/api/v1/me', 'get', 500, 'application/json')).toThrow(/no application\/json 500/)
  })
})

describe('IF-1 parameters', () => {
  const if1 = loadContract('IF-1')

  it('reads a query parameter schema and refuses an undocumented one', () => {
    expect(validate('//evil.example', if1.parameterSchema('/auth/login', 'get', 'returnTo'))).toHaveLength(1)
    expect(() => if1.parameterSchema('/auth/login', 'get', 'prompt')).toThrow(/no parameter prompt/)
  })
})
