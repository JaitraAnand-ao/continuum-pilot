/* ST-15 routes: administrators read the settings in effect (IF-40), tighten a threshold (IF-41), add a sensitive app
 * (IF-42) and search apps seen in the tenant (IF-43), each applied at once as a new config version with a
 * config.applied audit event. Readers are answered 403 and the denial is audited (AC-8). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ADMIN_ONLY, BOTH, READER } from './support/fake-keycloak.js'
import { signIn, withSession } from './support/harness.js'
import {
  createSettingsHarness,
  NEVER_SEEN_APP_ID,
  SEED_VERSION_ID,
  SEEDED_AT,
  WORKDAY,
  WORKPLACE,
  type SettingsHarness,
} from './support/settings-harness.js'

const SETTINGS = '/api/v1/detection-settings'
const REPEATED = `${SETTINGS}/thresholds/repeated_failures`
const SPRAY = `${SETTINGS}/thresholds/password_spray`
const APPS = `${SETTINGS}/sensitive-apps`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SAVE_FAILED = "Couldn't save. Your change wasn't applied and nothing was sent for approval."

let h: SettingsHarness
let admin: Record<string, string>

/* The first app a worker builds can take seconds under coverage instrumentation. */
beforeEach(async () => {
  h = createSettingsHarness()
  admin = withSession((await signIn(h, ADMIN_ONLY)).session)
}, 30_000)

afterEach(async () => {
  await h.app.close()
})

async function as(user: typeof READER) {
  return withSession((await signIn(h, user)).session)
}

function save(url: string, body: object, cookies = admin) {
  return h.app.inject({ method: 'PUT', url, cookies, payload: { configVersionId: SEED_VERSION_ID, ...body } })
}

function add(appId: string, cookies = admin, configVersionId = SEED_VERSION_ID) {
  return h.app.inject({ method: 'POST', url: APPS, cookies, payload: { configVersionId, appId } })
}

async function current() {
  return (await h.settings.current()).thresholds
}

describe('GET /api/v1/detection-settings (AC-2)', () => {
  it('shows the out-of-the-box thresholds with the date each has been in effect since', async () => {
    const response = await h.app.inject({ url: SETTINGS, cookies: admin })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toEqual({
      configVersionId: SEED_VERSION_ID,
      pendingCount: 0,
      thresholds: [
        {
          thresholdKey: 'repeated_failures',
          count: 10,
          windowMinutes: 60,
          defaultCount: 10,
          defaultWindowMinutes: 60,
          inEffectSince: SEEDED_AT,
          pending: null,
        },
        {
          thresholdKey: 'password_spray',
          count: 10,
          windowMinutes: 60,
          defaultCount: 10,
          defaultWindowMinutes: 60,
          inEffectSince: SEEDED_AT,
          pending: null,
        },
      ],
      sensitiveApps: [],
    })
  })

  it('is open to a person holding both the reader and administrator claims', async () => {
    const response = await h.app.inject({ url: SETTINGS, cookies: await as(BOTH) })
    expect(response.statusCode).toBe(200)
  })

  it('answers 503 without leaking the store error when the store does not respond', async () => {
    h.settings.failReads = true
    const response = await h.app.inject({ url: SETTINGS, cookies: admin })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ type: '/problems/settings-store-unavailable', status: 503 })
    expect(response.body).not.toContain('settings store offline')
  })
})

describe('PUT a threshold (AC-3)', () => {
  it('lowering the repeated failures count applies at once as a new version, from today’s report', async () => {
    const response = await save(REPEATED, { count: 8, windowMinutes: 60 })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body).toEqual({
      configVersionId: expect.stringMatching(UUID),
      appliesFromReportDate: '2026-10-12',
      threshold: {
        thresholdKey: 'repeated_failures',
        count: 8,
        windowMinutes: 60,
        defaultCount: 10,
        defaultWindowMinutes: 60,
        inEffectSince: '2026-10-12T09:30:00.000Z',
        pending: null,
      },
    })
    const versions = h.settings.versions()
    expect(versions).toHaveLength(2)
    expect(versions[1]).toMatchObject({
      id: body.configVersionId,
      previousId: SEED_VERSION_ID,
      createdBy: ADMIN_ONLY.upn,
      thresholds: { repeated_failures: { count: 8, windowMinutes: 60 } },
    })
    const read = (await h.app.inject({ url: SETTINGS, cookies: admin })).json()
    expect(read.configVersionId).toBe(body.configVersionId)
    expect(read.thresholds[0]).toMatchObject({ count: 8, inEffectSince: '2026-10-12T09:30:00.000Z' })
    expect(read.thresholds[1]).toMatchObject({ count: 10, inEffectSince: SEEDED_AT })
  })

  it('writes a config.applied audit event naming the administrator', async () => {
    const body = (await save(REPEATED, { count: 8, windowMinutes: 60 })).json()
    expect(h.audit.events).toContainEqual({
      type: 'config.applied',
      account: ADMIN_ONLY.upn,
      configVersionId: body.configVersionId,
      previousConfigVersionId: SEED_VERSION_ID,
      change: {
        setting: 'repeated_failures',
        from: { count: 10, windowMinutes: 60 },
        to: { count: 8, windowMinutes: 60 },
      },
      traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
      at: '2026-10-12T09:30:00.000Z',
    })
  })

  it('widening the password spray window to 2 hours saves without approval', async () => {
    const response = await save(SPRAY, { count: 10, windowMinutes: 120 })
    expect(response.statusCode).toBe(200)
    expect((await current()).password_spray).toMatchObject({ count: 10, windowMinutes: 120 })
  })

  it('a count of 1 is accepted', async () => {
    expect((await save(REPEATED, { count: 1, windowMinutes: 60 })).statusCode).toBe(200)
  })

  it.each([0, -3, 7.5])(
    'refuses a count of %s with the whole-number message and stores nothing (AC-5)',
    async (count) => {
      const response = await save(REPEATED, { count, windowMinutes: 60 })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({
        type: '/problems/invalid-threshold',
        title: 'Enter a whole number of 1 or more',
        status: 400,
      })
      expect((await current()).repeated_failures.count).toBe(10)
      expect(h.settings.versions()).toHaveLength(1)
      expect(h.audit.events.filter((event) => event.type === 'config.applied')).toEqual([])
    },
  )

  it('refuses a window wider than a day', async () => {
    const response = await save(SPRAY, { count: 10, windowMinutes: 1441 })
    expect(response.statusCode).toBe(400)
    expect(response.json().title).toBe('Enter a whole number of minutes from 1 to 1440')
    expect(h.settings.versions()).toHaveLength(1)
  })

  it('refuses a malformed body', async () => {
    const response = await save(REPEATED, { count: 'eight', windowMinutes: 60 })
    expect(response.statusCode).toBe(400)
    expect(h.settings.versions()).toHaveLength(1)
  })

  it('refuses an unknown threshold', async () => {
    const response = await save(`${SETTINGS}/thresholds/impossible_travel`, { count: 1, windowMinutes: 60 })
    expect(response.statusCode).toBe(400)
  })

  it('refuses a loosening change here, leaving it to the approval flow', async () => {
    const response = await save(REPEATED, { count: 15, windowMinutes: 60 })
    expect(response.statusCode).toBe(409)
    expect(response.json().type).toBe('/problems/loosening-requires-approval')
    expect((await current()).repeated_failures.count).toBe(10)
    expect(h.settings.versions()).toHaveLength(1)
  })

  it('refuses an unchanged value without making a version', async () => {
    const response = await save(REPEATED, { count: 10, windowMinutes: 60 })
    expect(response.statusCode).toBe(409)
    expect(response.json().type).toBe('/problems/unchanged')
    expect(h.settings.versions()).toHaveLength(1)
  })

  it('refuses a save made against a version that is no longer current', async () => {
    expect((await save(REPEATED, { count: 9, windowMinutes: 60 })).statusCode).toBe(200)
    const response = await save(REPEATED, { count: 8, windowMinutes: 60 })
    expect(response.statusCode).toBe(409)
    expect(response.json().type).toBe('/problems/stale-version')
    expect((await current()).repeated_failures.count).toBe(9)
  })

  it('refuses when another save lands between reading and writing', async () => {
    h.settings.raceNextWrite = true
    const response = await save(REPEATED, { count: 8, windowMinutes: 60 })
    expect(response.statusCode).toBe(409)
    expect(response.json().type).toBe('/problems/stale-version')
    expect(h.audit.events.filter((event) => event.type === 'config.applied')).toEqual([])
  })

  it('a failed save reads the couldn’t-save message, applies nothing and audits nothing (AC-7)', async () => {
    h.settings.failWrites = true
    const response = await save(REPEATED, { count: 8, windowMinutes: 60 })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ type: '/problems/settings-store-unavailable', title: SAVE_FAILED })
    expect(response.body).not.toContain('settings store offline')
    expect((await current()).repeated_failures.count).toBe(10)
    expect(h.audit.events.filter((event) => event.type === 'config.applied')).toEqual([])
  })

  it('a store that cannot be read on save answers the same 503', async () => {
    h.settings.failReads = true
    const response = await save(REPEATED, { count: 8, windowMinutes: 60 })
    expect(response.statusCode).toBe(503)
    expect(response.json().title).toBe(SAVE_FAILED)
  })
})

describe('POST a sensitive application (AC-4, AC-5)', () => {
  it('adds Workday with its ID, the administrator’s name and today’s date', async () => {
    const response = await add(WORKDAY.appId)
    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body).toEqual({
      configVersionId: expect.stringMatching(UUID),
      appliesFromReportDate: '2026-10-12',
      app: {
        appId: WORKDAY.appId,
        appName: 'Workday',
        addedBy: ADMIN_ONLY.name,
        addedAt: '2026-10-12T09:30:00.000Z',
        pending: null,
      },
    })
    const read = (await h.app.inject({ url: SETTINGS, cookies: admin })).json()
    expect(read.configVersionId).toBe(body.configVersionId)
    expect(read.sensitiveApps).toEqual([body.app])
    expect(h.audit.events).toContainEqual({
      type: 'config.applied',
      account: ADMIN_ONLY.upn,
      configVersionId: body.configVersionId,
      previousConfigVersionId: SEED_VERSION_ID,
      change: { setting: 'sensitive_apps', added: { appId: WORKDAY.appId, appName: 'Workday' } },
      traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
      at: '2026-10-12T09:30:00.000Z',
    })
  })

  it('accepts a pasted ID in upper case and stores it in canonical form', async () => {
    const response = await add(WORKDAY.appId.toUpperCase())
    expect(response.statusCode).toBe(201)
    expect(response.json().app.appId).toBe(WORKDAY.appId)
  })

  it('refuses an ID never seen in the tenant’s sign-ins, leaving the list unchanged', async () => {
    const response = await add(NEVER_SEEN_APP_ID)
    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({
      type: '/problems/unknown-application',
      title: "That isn't an application ID seen in this tenant's sign-ins",
    })
    expect((await h.settings.current()).sensitiveApps).toEqual([])
    expect(h.settings.versions()).toHaveLength(1)
  })

  it('refuses something that is not an application ID', async () => {
    expect((await add('workday')).statusCode).toBe(400)
  })

  it('refuses an app already on the list', async () => {
    const first = (await add(WORKDAY.appId)).json()
    const response = await add(WORKDAY.appId, admin, first.configVersionId)
    expect(response.statusCode).toBe(409)
    expect(response.json().type).toBe('/problems/already-sensitive')
    expect(h.settings.versions()).toHaveLength(2)
  })

  it('refuses an add made against a version that is no longer current', async () => {
    await add(WORKDAY.appId)
    const response = await add(WORKPLACE.appId)
    expect(response.statusCode).toBe(409)
    expect(response.json().type).toBe('/problems/stale-version')
  })

  it('a failed save reads the couldn’t-save message', async () => {
    h.settings.failWrites = true
    const response = await add(WORKDAY.appId)
    expect(response.statusCode).toBe(503)
    expect(response.json().title).toBe(SAVE_FAILED)
    expect(h.audit.events.filter((event) => event.type === 'config.applied')).toEqual([])
  })

  it('a tenant directory that does not respond answers 503', async () => {
    h.tenantApps.fail = true
    expect((await add(WORKDAY.appId)).statusCode).toBe(503)
  })
})

describe('GET apps seen in the tenant (AC-4)', () => {
  it('finds apps by name, marking those already sensitive', async () => {
    await add(WORKDAY.appId)
    const response = await h.app.inject({ url: `${SETTINGS}/tenant-apps?q=work`, cookies: admin })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      items: [
        { appId: WORKDAY.appId, appName: 'Workday', sensitive: true },
        { appId: WORKPLACE.appId, appName: 'Workplace Analytics', sensitive: false },
      ],
    })
  })

  it('finds an app by its pasted ID', async () => {
    const response = await h.app.inject({ url: `${SETTINGS}/tenant-apps?q=${WORKPLACE.appId}`, cookies: admin })
    expect(response.json().items).toEqual([
      { appId: WORKPLACE.appId, appName: 'Workplace Analytics', sensitive: false },
    ])
  })

  it('refuses a missing query', async () => {
    expect((await h.app.inject({ url: `${SETTINGS}/tenant-apps`, cookies: admin })).statusCode).toBe(400)
  })

  it('answers 503 when the directory does not respond', async () => {
    h.tenantApps.fail = true
    const response = await h.app.inject({ url: `${SETTINGS}/tenant-apps?q=work`, cookies: admin })
    expect(response.statusCode).toBe(503)
  })
})

describe('a reader without the administrator role (AC-8)', () => {
  it.each([
    ['GET', SETTINGS, 'config.read'],
    ['PUT', REPEATED, 'config.write'],
    ['POST', APPS, 'config.write'],
    ['GET', `${SETTINGS}/tenant-apps?q=work`, 'config.write'],
  ] as const)('%s %s answers 403 with no values, and the denial is audited', async (method, url, requiredRole) => {
    const reader = await as(READER)
    const response = await h.app.inject({
      method,
      url,
      cookies: reader,
      ...(method === 'GET' ? {} : { payload: { configVersionId: SEED_VERSION_ID, count: 1, windowMinutes: 60 } }),
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({
      type: '/problems/forbidden',
      title: 'Forbidden',
      status: 403,
      traceId: expect.any(String),
    })
    expect(h.audit.events).toContainEqual(
      expect.objectContaining({ type: 'access-denied', account: READER.upn, reason: 'missing-role', requiredRole }),
    )
    expect(h.settings.versions()).toHaveLength(1)
  })

  it('an anonymous caller is answered 401', async () => {
    expect((await h.app.inject({ url: SETTINGS })).statusCode).toBe(401)
    expect((await h.app.inject({ method: 'PUT', url: REPEATED, payload: {} })).statusCode).toBe(401)
  })
})
