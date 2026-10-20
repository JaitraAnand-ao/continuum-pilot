/* ST-18: the recipient endpoints behind Email recipients (IF-51 to IF-56), one block per acceptance criterion. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ADMIN_ONLY, BOTH, READER } from './support/fake-keycloak.js'
import { createHarness, signIn, withSession, type Harness } from './support/harness.js'

let h: Harness
let admin: string | undefined

const SOC = {
  id: 'r-soc',
  directoryId: 'g-soc',
  kind: 'group' as const,
  displayName: 'SOC team',
  address: 'soc@contoso.com',
  memberCount: 5,
  status: 'active' as const,
  addedBy: 'a.admin@contoso.com',
  addedAt: '2026-10-01T09:00:00.000Z',
}

function seedDirectory(h: Harness) {
  const d = h.directory
  d.person('u-dchen', 'd.chen').person('u-portiz', 'p.ortiz').person('u-mvance', 'm.vance')
  for (let i = 1; i <= 5; i++) d.person(`u-soc${i}`, `soc${i}`)
  d.group('g-soc', 'SOC team', 'soc@contoso.com', ['u-soc1', 'u-soc2', 'u-soc3', 'u-soc4', 'u-soc5'])
  d.group('g-analysts', 'analysts', 'analysts@contoso.com', ['u-portiz'])
  d.person('u-on1', 'on1').person('u-on2', 'on2')
  d.group('g-oncall', 'sec-oncall', 'sec-oncall@contoso.com', ['u-on1', 'u-on2'])
  const itAll: string[] = []
  for (let i = 0; i < 240; i++) {
    d.person(`u-it${i}`, `it${String(i).padStart(3, '0')}`)
    itAll.push(`u-it${i}`)
  }
  d.group('g-itall', 'it-all', 'it-all@contoso.com', itAll)
  d.group('g-empty', 'nobody', 'nobody@contoso.com', [])
  d.addToReaders('u-dchen', 'g-analysts', 'g-soc', 'u-on1', 'u-on2', ...itAll.slice(3))
}

beforeEach(async () => {
  h = createHarness('2026-10-20T10:00:00.000Z')
  seedDirectory(h)
  admin = (await signIn(h, ADMIN_ONLY)).session
  /* The first sign-in of a run warms the fake Keycloak's keys, which is slow while every file runs in parallel. */
}, 60_000)

afterEach(async () => {
  await h.app.close()
})

const list = (session = admin) => h.app.inject({ url: '/api/v1/recipients', cookies: withSession(session) })
const checkAndAdd = (directoryId: string, session = admin) =>
  h.app.inject({ method: 'POST', url: '/api/v1/recipients', cookies: withSession(session), payload: { directoryId } })
const remove = (id: string, session = admin) =>
  h.app.inject({ method: 'DELETE', url: `/api/v1/recipients/${id}`, cookies: withSession(session) })
const withdraw = (id: string, session = admin) =>
  h.app.inject({ method: 'DELETE', url: `/api/v1/recipients/${id}/proposal`, cookies: withSession(session) })
const recipientTypes = () => h.audit.events.map((event) => event.type).filter((type) => type.startsWith('recipient.'))

describe('AC-1 the recipient list', () => {
  it('shows a group with its type, check, status, who added it and the Remove action named for it', async () => {
    await h.recipients.add(SOC)
    const response = await list()
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      recipients: [
        {
          id: 'r-soc',
          kind: 'group',
          displayName: 'SOC team',
          address: 'soc@contoso.com',
          memberCount: 5,
          typeText: 'Group with 5 members',
          checkText: 'All 5 members',
          status: 'active',
          statusText: 'Active',
          addedBy: 'a.admin@contoso.com',
          addedAt: '2026-10-01T09:00:00.000Z',
          action: { kind: 'remove', label: 'Remove SOC team, soc@contoso.com' },
        },
      ],
    })
  })

  it('names Withdraw for a recipient waiting for approval, and lists recipients by name', async () => {
    await h.recipients.add(SOC)
    await checkAndAdd('u-dchen')
    const rows = list().then((response) => response.json().recipients)
    const [first, second] = await rows
    expect(first).toMatchObject({ displayName: 'd.chen', kind: 'person', typeText: 'Person', memberCount: null })
    expect(first).toMatchObject({ checkText: 'In the reader group', statusText: 'Waiting for approval' })
    expect(first.action).toEqual({ kind: 'withdraw', label: 'Withdraw d.chen, d.chen@contoso.com' })
    expect(second.displayName).toBe('SOC team')
  })
})

describe('AC-2 a reader is sent for approval', () => {
  it('lists d.chen as Waiting for approval, added by me, and announces it', async () => {
    const response = await checkAndAdd('u-dchen')
    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.announcement).toBe('d.chen passed the check and was sent for approval; no email until approved')
    expect(body.recipient).toMatchObject({
      displayName: 'd.chen',
      address: 'd.chen@contoso.com',
      status: 'pending',
      statusText: 'Waiting for approval',
      addedBy: ADMIN_ONLY.upn,
      addedAt: '2026-10-20T10:00:00.000Z',
    })
    expect((await list()).json().recipients.map((row: { displayName: string }) => row.displayName)).toEqual(['d.chen'])
  })

  it('counts membership through a nested group', async () => {
    const response = await checkAndAdd('u-portiz')
    expect(response.statusCode).toBe(201)
    expect(response.json().recipient.status).toBe('pending')
  })

  it('finds people and groups to check through the directory search', async () => {
    const response = await h.app.inject({ url: '/api/v1/recipients/directory?q=d.chen', cookies: withSession(admin) })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      results: [{ directoryId: 'u-dchen', kind: 'person', displayName: 'd.chen', address: 'd.chen@contoso.com' }],
    })
  })

  it('accepts search texts of 2 and 64 characters and returns at most 25 results', async () => {
    for (let i = 0; i < 26; i++) h.directory.person(`u-many${i}`, `zz-many${i}`)
    const short = await h.app.inject({ url: '/api/v1/recipients/directory?q=zz', cookies: withSession(admin) })
    expect(short.statusCode).toBe(200)
    expect(short.json().results).toHaveLength(25)
    const long = await h.app.inject({
      url: `/api/v1/recipients/directory?q=${'x'.repeat(64)}`,
      cookies: withSession(admin),
    })
    expect(long.statusCode).toBe(200)
    expect(long.json().results).toEqual([])
  })

  it('refuses a search text outside the allowed characters without asking the directory', async () => {
    for (const q of ["x'%20or%201", 'a', 'x'.repeat(65)]) {
      const response = await h.app.inject({ url: `/api/v1/recipients/directory?q=${q}`, cookies: withSession(admin) })
      expect(response.statusCode, q).toBe(400)
    }
    expect(h.directory.searches).toEqual([])
  })

  it('answers 503 when the directory search cannot be completed', async () => {
    h.directory.failing = true
    const response = await h.app.inject({ url: '/api/v1/recipients/directory?q=chen', cookies: withSession(admin) })
    expect(response.statusCode).toBe(503)
    expect(response.json().type).toBe('/problems/directory-unavailable')
  })

  it('refuses to add someone already listed, and an id the directory does not know', async () => {
    await h.recipients.add(SOC)
    const again = await checkAndAdd('g-soc')
    expect(again.statusCode).toBe(409)
    expect(again.json().title).toBe('SOC team is already a recipient.')
    expect((await checkAndAdd('u-ghost')).statusCode).toBe(404)
    expect((await checkAndAdd('x'.repeat(64))).statusCode).toBe(404)
    expect((await checkAndAdd('x'.repeat(65))).statusCode).toBe(400)
    expect((await checkAndAdd('u dchen')).statusCode).toBe(400)
    expect((await list()).json().recipients).toHaveLength(1)
  })

  it('refuses a directory id that is not a string rather than coercing it', async () => {
    for (const directoryId of [123, ['u-dchen'], null]) {
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/v1/recipients',
        cookies: withSession(admin),
        payload: { directoryId },
      })
      expect(response.statusCode, JSON.stringify(directoryId)).toBe(400)
    }
    expect(await h.recipients.list()).toEqual([])
  })

  it('lets only one of two simultaneous additions of the same person through', async () => {
    const responses = await Promise.all([checkAndAdd('u-dchen'), checkAndAdd('u-dchen')])
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409])
    expect(await h.recipients.list()).toHaveLength(1)
  })

  it('answers 409 when the store finds the duplicate that the earlier lookup missed', async () => {
    await h.recipients.add(SOC)
    h.recipients.findByDirectoryId = async () => undefined
    const response = await checkAndAdd('g-soc')
    expect(response.statusCode).toBe(409)
    expect(response.json().title).toBe('SOC team is already a recipient.')
    expect(await h.recipients.list()).toHaveLength(1)
  })
})

describe('AC-3 a person outside the reader group', () => {
  it('is rejected in the words of the story and nothing is saved', async () => {
    const response = await checkAndAdd('u-mvance')
    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({
      type: '/problems/recipient-not-reader',
      title:
        "m.vance isn't in the reader group, so they can't receive reports. Ask your Entra administrator to add them first.",
      status: 422,
    })
    expect(await h.recipients.list()).toEqual([])
  })
})

describe('AC-4 distribution groups', () => {
  it('rejects a group with outsiders, giving their count and addresses, and saves nothing', async () => {
    const response = await checkAndAdd('g-itall')
    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({
      type: '/problems/recipient-group-outsiders',
      title: 'it-all has 3 of 240 members outside the reader group',
      outsiders: { count: 3, total: 240, addresses: ['it000@contoso.com', 'it001@contoso.com', 'it002@contoso.com'] },
    })
    expect(await h.recipients.list()).toEqual([])
  })

  it('accepts a group whose every member is a reader for approval', async () => {
    const response = await checkAndAdd('g-oncall')
    expect(response.statusCode).toBe(201)
    expect(response.json().recipient).toMatchObject({
      displayName: 'sec-oncall',
      kind: 'group',
      memberCount: 2,
      checkText: 'All 2 members',
      statusText: 'Waiting for approval',
    })
  })

  it('rejects a group with no members without asking about readers', async () => {
    h.directory.readersAmong = async () => {
      throw new Error('readersAmong called with nobody')
    }
    const response = await checkAndAdd('g-empty')
    expect(response.statusCode).toBe(422)
    expect(response.json().type).toBe('/problems/recipient-empty-group')
    expect(await h.recipients.list()).toEqual([])
  })
})

describe('AC-5 the membership check fails closed', () => {
  it('rejects d.chen, saves nothing, audits recipient.check_failed and raises the alarm metric', async () => {
    h.directory.failing = true
    const response = await checkAndAdd('u-dchen')
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({
      type: '/problems/recipient-check-failed',
      title: "Couldn't check the reader group, so the recipient wasn't added. Try again later.",
    })
    expect(await h.recipients.list()).toEqual([])
    expect(h.audit.events.at(-1)).toMatchObject({
      type: 'recipient.check_failed',
      account: ADMIN_ONLY.upn,
      target: 'u-dchen',
      at: '2026-10-20T10:00:00.000Z',
    })
    expect(h.metrics.metrics).toEqual([
      {
        namespace: 'SigninReports',
        name: 'RecipientCheckFailed',
        value: 1,
        dimensions: {},
        timestamp: '2026-10-20T10:00:00.000Z',
      },
    ])
  })

  it('fails closed when the lookup breaks part-way, after the entry was found', async () => {
    const readersAmong = h.directory.readersAmong.bind(h.directory)
    h.directory.readersAmong = async () => {
      throw new Error('socket hang up at graph.microsoft.com')
    }
    const response = await checkAndAdd('u-dchen')
    expect(response.statusCode).toBe(503)
    expect(response.json().title).toBe("Couldn't check the reader group, so d.chen wasn't added. Try again later.")
    expect(response.body).not.toContain('graph.microsoft.com')
    expect(await h.recipients.list()).toEqual([])
    expect(h.metrics.metrics).toHaveLength(1)
    expect(h.audit.events.at(-1)).toMatchObject({ type: 'recipient.check_failed', target: 'u-dchen' })
    h.directory.readersAmong = readersAmong
  })

  it('fails closed when a group cannot be expanded', async () => {
    h.directory.groupMembers = async () => {
      throw new Error('nextLink pointed at a foreign host')
    }
    const response = await checkAndAdd('g-oncall')
    expect(response.statusCode).toBe(503)
    expect(response.json().title).toBe("Couldn't check the reader group, so sec-oncall wasn't added. Try again later.")
    expect(await h.recipients.list()).toEqual([])
    expect(h.metrics.metrics).toHaveLength(1)
  })

  it('still answers 503 and raises the alarm when the audit write fails, and audits when the metric fails', async () => {
    h.directory.failing = true
    const record = h.audit.record.bind(h.audit)
    h.audit.record = async (event) => {
      if (event.type === 'recipient.check_failed') throw new Error('audit sink down')
      return record(event)
    }
    expect((await checkAndAdd('u-dchen')).json().type).toBe('/problems/recipient-check-failed')
    expect(h.metrics.metrics).toHaveLength(1)
    h.audit.record = record
    h.metrics.put = async () => {
      throw new Error('cloudwatch down')
    }
    expect((await checkAndAdd('u-dchen')).json().type).toBe('/problems/recipient-check-failed')
    expect(h.audit.events.filter((event) => event.type === 'recipient.check_failed')).toHaveLength(1)
    expect(await h.recipients.list()).toEqual([])
  })
})

describe('AC-6 removing a recipient applies at once', () => {
  it('removes SOC team without approval and announces it', async () => {
    await h.recipients.add(SOC)
    const response = await remove('r-soc')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      announcement: "SOC team removed. They won't get tomorrow's email",
      confirmation: "They won't get tomorrow's email",
    })
    expect((await list()).json().recipients).toEqual([])
  })

  it('withdraws a proposal waiting for approval', async () => {
    const id = (await checkAndAdd('u-dchen')).json().recipient.id
    const response = await withdraw(id)
    expect(response.statusCode).toBe(200)
    expect(response.json().announcement).toBe('d.chen withdrawn. No approval is needed now')
    expect(await h.recipients.list()).toEqual([])
  })

  it('answers 409 when the action does not fit the status, and 404 for an unknown recipient', async () => {
    await h.recipients.add(SOC)
    const pending = (await checkAndAdd('u-dchen')).json().recipient.id
    const wrongRemove = await remove(pending)
    expect(wrongRemove.statusCode).toBe(409)
    expect(wrongRemove.json().title).toBe('d.chen is waiting for approval; withdraw it instead.')
    const wrongWithdraw = await withdraw('r-soc')
    expect(wrongWithdraw.statusCode).toBe(409)
    expect(wrongWithdraw.json().title).toBe('SOC team is already active; remove it instead.')
    expect((await remove('r-ghost')).statusCode).toBe(404)
    expect((await withdraw('r-ghost')).statusCode).toBe(404)
    expect(await h.recipients.list()).toHaveLength(2)
  })
})

describe('AC-7 nobody receives the email', () => {
  it('says so and notes reports are still generated in the dashboard', async () => {
    const response = await list()
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      recipients: [],
      empty: { title: 'Nobody receives the daily email', note: 'Reports are still generated in the dashboard.' },
    })
  })
})

describe('AC-8 a failed save', () => {
  it('reads "Couldn\'t save. The recipient list is unchanged." when a removal cannot be written', async () => {
    await h.recipients.add(SOC)
    h.recipients.rejectWrites = true
    const response = await remove('r-soc')
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({
      type: '/problems/recipient-save-failed',
      title: "Couldn't save. The recipient list is unchanged.",
    })
    h.recipients.rejectWrites = false
    expect((await list()).json().recipients).toHaveLength(1)
    expect(recipientTypes()).not.toContain('recipient.removed')
  })

  it('reads the same when a proposal or a withdrawal cannot be written', async () => {
    const id = (await checkAndAdd('u-dchen')).json().recipient.id
    h.recipients.rejectWrites = true
    expect((await checkAndAdd('g-oncall')).json().type).toBe('/problems/recipient-save-failed')
    expect((await withdraw(id)).json().type).toBe('/problems/recipient-save-failed')
    h.recipients.rejectWrites = false
    expect((await h.recipients.list()).map((row) => row.displayName)).toEqual(['d.chen'])
  })

  it('answers 503 when the list cannot be read', async () => {
    h.recipients.rejectReads = true
    const response = await list()
    expect(response.statusCode).toBe(503)
    expect(response.json().type).toBe('/problems/recipient-store-unavailable')
  })
})

describe('AC-9 a reader cannot manage recipients', () => {
  it('answers 403 with the administrators-only message on every recipient endpoint, audited', async () => {
    const reader = (await signIn(h, READER)).session
    const responses = [
      await list(reader),
      await checkAndAdd('u-dchen', reader),
      await remove('r-soc', reader),
      await withdraw('r-soc', reader),
      await h.app.inject({ url: '/api/v1/recipients/directory?q=chen', cookies: withSession(reader) }),
      await h.app.inject({ url: '/api/v1/recipients/audit', cookies: withSession(reader) }),
    ]
    for (const response of responses) {
      expect(response.statusCode).toBe(403)
      expect(response.json()).toMatchObject({
        type: '/problems/admin-only',
        title: 'Only report administrators can manage recipients.',
      })
    }
    expect(await h.recipients.list()).toEqual([])
    expect(h.directory.searches).toEqual([])
    const denials = h.audit.events.filter((event) => event.type === 'access-denied')
    expect(denials).toHaveLength(6)
    expect(denials.every((event) => event.account === READER.upn)).toBe(true)
  })

  it('answers 401 without a session and lets an administrator who is also a reader in', async () => {
    expect((await h.app.inject({ url: '/api/v1/recipients' })).statusCode).toBe(401)
    const both = (await signIn(h, BOTH)).session
    expect((await list(both)).statusCode).toBe(200)
  })
})

describe('AC-10 recipient changes are audited', () => {
  it('records the removal, the check and the proposal with my identity, and serves them as the audit trail', async () => {
    await h.recipients.add(SOC)
    await remove('r-soc')
    h.clock.advance(60_000)
    await checkAndAdd('g-oncall')
    await checkAndAdd('u-mvance')
    expect(recipientTypes()).toEqual([
      'recipient.removed',
      'recipient.checked',
      'recipient.proposed',
      'recipient.checked',
    ])
    const response = await h.app.inject({ url: '/api/v1/recipients/audit', cookies: withSession(admin) })
    expect(response.statusCode).toBe(200)
    const events = response.json().events
    expect(events).toEqual([
      {
        type: 'recipient.checked',
        account: ADMIN_ONLY.upn,
        target: 'u-mvance',
        outcome: 'not-reader',
        at: '2026-10-20T10:01:00.000Z',
      },
      { type: 'recipient.proposed', account: ADMIN_ONLY.upn, target: 'g-oncall', at: '2026-10-20T10:01:00.000Z' },
      {
        type: 'recipient.checked',
        account: ADMIN_ONLY.upn,
        target: 'g-oncall',
        outcome: 'eligible',
        at: '2026-10-20T10:01:00.000Z',
      },
      { type: 'recipient.removed', account: ADMIN_ONLY.upn, target: 'g-soc', at: '2026-10-20T10:00:00.000Z' },
    ])
  })

  it('answers 503 when the audit trail cannot be read', async () => {
    h.audit.recipientEvents = async () => {
      throw new Error('relation "audit_events" does not exist')
    }
    const response = await h.app.inject({ url: '/api/v1/recipients/audit', cookies: withSession(admin) })
    expect(response.statusCode).toBe(503)
    expect(response.json().type).toBe('/problems/audit-unavailable')
    expect(response.body).not.toContain('audit_events')
  })

  it('audits a withdrawal, and carries the trace id but no address on each event', async () => {
    const id = (await checkAndAdd('u-dchen')).json().recipient.id
    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/recipients/${id}/proposal`,
      cookies: withSession(admin),
      headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
    })
    const last = h.audit.events.at(-1)
    expect(last).toMatchObject({
      type: 'recipient.withdrawn',
      target: 'u-dchen',
      traceId: '0af7651916cd43dd8448eb211c80319c',
    })
    expect(JSON.stringify(h.audit.events)).not.toContain('d.chen@contoso.com')
  })
})
