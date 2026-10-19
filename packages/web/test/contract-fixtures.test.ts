import { describe, expect, it } from 'vitest'
import { getMe } from '../src/api/client'
import { jsonResponse, meFor, NO_ACCESS, responseSchema, violations } from './fixtures'

describe('IF-4 fixtures honour the committed contract', () => {
  it('accepts the reader, both-roles and administrator-only bodies', () => {
    for (const roles of [['reader'], ['reader', 'config.read'], ['config.read']] as const) {
      expect(violations(meFor([...roles]), responseSchema('200'))).toEqual([])
    }
  })

  it('rejects a body the BFF could not send', () => {
    expect(violations({ ...meFor(['reader']), accessToken: 'x' }, responseSchema('200'))).toContain(
      '$.accessToken: not allowed',
    )
    expect(violations({ ...meFor(['reader']), roles: ['owner'] }, responseSchema('200'))).toContain(
      '$.roles[0]: not in enum',
    )
    expect(violations({ ...NO_ACCESS, title: 'Forbidden' }, responseSchema('403'))).toContain('$.title: pattern')
    expect(violations({ ...NO_ACCESS, detail: 'x' }, responseSchema('403'))).toContain('$.detail: not allowed')
  })

  it('the client accepts every body the contract allows', async () => {
    for (const roles of [['reader'], ['reader', 'config.read'], ['config.read'], []] as const) {
      const me = meFor([...roles])
      expect(await getMe(async () => jsonResponse(200, me))).toEqual({ status: 200, me })
    }
    expect(await getMe(async () => jsonResponse(403, NO_ACCESS))).toEqual({ status: 403, problem: NO_ACCESS })
  })
})
