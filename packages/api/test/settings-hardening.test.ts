/* ST-15 edges found in review: only JSON numbers are thresholds, IDs are compared in canonical lower case, the
 * version history is append-only, and every remaining documented status is checked against its contract. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InMemoryTenantAppDirectory } from '../src/settings/store.js'
import { MAX_WINDOW_MINUTES, validateThreshold } from '../src/settings/rules.js'
import { check } from './support/contract.js'
import { ADMIN_ONLY } from './support/fake-keycloak.js'
import { signIn, withSession } from './support/harness.js'
import {
  createSettingsHarness,
  SEED_VERSION_ID,
  WORKDAY,
  WORKPLACE,
  type SettingsHarness,
} from './support/settings-harness.js'

const SETTINGS = '/api/v1/detection-settings'
const REPEATED = `${SETTINGS}/thresholds/repeated_failures`
const SPRAY = `${SETTINGS}/thresholds/password_spray`
const THRESHOLD = `${SETTINGS}/thresholds/{thresholdKey}`
const APPS = `${SETTINGS}/sensitive-apps`
const SEARCH = `${SETTINGS}/tenant-apps`

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

const save = (url: string, body: object) =>
  h.app.inject({ method: 'PUT', url, cookies: admin, payload: { configVersionId: SEED_VERSION_ID, ...body } })

const add = (appId: string, configVersionId = SEED_VERSION_ID) =>
  h.app.inject({ method: 'POST', url: APPS, cookies: admin, payload: { configVersionId, appId } })

describe('thresholds are JSON numbers, never coerced (AC-5)', () => {
  it.each([true, '8', null])('a count of %j reads the whole-number message and stores nothing', async (count) => {
    const response = await save(REPEATED, { count, windowMinutes: 60 })
    expect(response.statusCode).toBe(400)
    expect(response.json().title).toBe('Enter a whole number of 1 or more')
    expect(h.settings.versions()).toHaveLength(1)
  })

  it('a window given as a string is refused', async () => {
    const response = await save(SPRAY, { count: 10, windowMinutes: '120' })
    expect(response.statusCode).toBe(400)
    expect(response.json().title).toBe('Enter a whole number of minutes from 1 to 1440')
  })

  it('a missing body is refused', async () => {
    const response = await h.app.inject({ method: 'PUT', url: REPEATED, cookies: admin })
    expect(response.statusCode).toBe(400)
  })

  it('a window of a full day is accepted, one minute more is not', async () => {
    expect((await save(SPRAY, { count: 10, windowMinutes: MAX_WINDOW_MINUTES })).statusCode).toBe(200)
    expect(validateThreshold({ count: 10, windowMinutes: MAX_WINDOW_MINUTES + 1 }).ok).toBe(false)
  })

  it('the largest safe whole number is a valid count, the next is not', () => {
    expect(validateThreshold({ count: Number.MAX_SAFE_INTEGER, windowMinutes: 60 }).ok).toBe(true)
    expect(validateThreshold({ count: Number.MAX_SAFE_INTEGER + 1, windowMinutes: 60 }).ok).toBe(false)
  })
})

describe('IDs in canonical lower case', () => {
  it('refuses the urn:uuid: form instead of reading it as an unknown application', async () => {
    const response = await add(`urn:uuid:${WORKDAY.appId}`)
    expect(response.statusCode).toBe(400)
  })

  it('accepts the version ID in upper case', async () => {
    expect(
      (await save(REPEATED, { count: 8, windowMinutes: 60, configVersionId: SEED_VERSION_ID.toUpperCase() }))
        .statusCode,
    ).toBe(200)
    expect((await add(WORKDAY.appId, (await h.settings.current()).id.toUpperCase())).statusCode).toBe(201)
  })

  it('the directory holds and finds IDs in lower case whatever case it was given', async () => {
    const directory = new InMemoryTenantAppDirectory([{ appId: WORKDAY.appId.toUpperCase(), appName: 'Workday' }])
    expect(await directory.find(WORKDAY.appId)).toEqual(WORKDAY)
    expect(await directory.find(WORKDAY.appId.toUpperCase())).toEqual(WORKDAY)
    expect(await directory.search(WORKDAY.appId.slice(0, 8).toUpperCase(), 20)).toEqual([WORKDAY])
  })
})

describe('the version history is append-only (AC-3)', () => {
  it('a save leaves every earlier version exactly as it was', async () => {
    const [seed] = h.settings.versions()
    await save(REPEATED, { count: 8, windowMinutes: 60 })
    await add(WORKDAY.appId, (await h.settings.current()).id)
    const versions = h.settings.versions()
    expect(versions).toHaveLength(3)
    expect(versions[0]).toEqual(seed)
    expect(versions[1]!.sensitiveApps).toEqual([])
    expect(versions[2]!.previousId).toBe(versions[1]!.id)
  })
})

describe('the remaining documented statuses match their contracts', () => {
  it('IF-41 409 for an unchanged value and for a stale version', async () => {
    check('IF-41', THRESHOLD, 'put', await save(REPEATED, { count: 10, windowMinutes: 60 }))
    await save(REPEATED, { count: 9, windowMinutes: 60 })
    check('IF-41', THRESHOLD, 'put', await save(REPEATED, { count: 8, windowMinutes: 60 }))
  })

  it('IF-41 400 for a window outside a day and for a malformed body', async () => {
    check('IF-41', THRESHOLD, 'put', await save(SPRAY, { count: 10, windowMinutes: 1441 }))
    check('IF-41', THRESHOLD, 'put', await save(REPEATED, { count: 8, windowMinutes: 60, configVersionId: 'v1' }))
  })

  it('IF-41 and IF-42 415 for a body that is not JSON', async () => {
    const text = { cookies: admin, headers: { 'content-type': 'application/xml' }, payload: '<count>8</count>' }
    const put = await h.app.inject({ method: 'PUT', url: REPEATED, ...text })
    expect(put.statusCode).toBe(415)
    check('IF-41', THRESHOLD, 'put', put)
    const post = await h.app.inject({ method: 'POST', url: APPS, ...text })
    expect(post.statusCode).toBe(415)
    check('IF-42', APPS, 'post', post)
  })

  it('IF-42 409 for a stale version', async () => {
    await add(WORKDAY.appId)
    check('IF-42', APPS, 'post', await add(WORKPLACE.appId))
  })

  it('IF-42 503 when the tenant directory does not respond', async () => {
    h.tenantApps.fail = true
    check('IF-42', APPS, 'post', await add(WORKDAY.appId))
  })

  it('IF-43 503 when the settings store does not respond', async () => {
    h.settings.failReads = true
    const response = await h.app.inject({ url: `${SEARCH}?q=work`, cookies: admin })
    expect(response.statusCode).toBe(503)
    check('IF-43', SEARCH, 'get', response)
  })

  it('IF-42 and IF-43 401 without a session', async () => {
    expect((await h.app.inject({ method: 'POST', url: APPS, payload: {} })).statusCode).toBe(401)
    expect((await h.app.inject({ url: `${SEARCH}?q=work` })).statusCode).toBe(401)
  })
})
