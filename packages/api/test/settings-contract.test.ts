/* contracts-honoured: every documented status of IF-40 to IF-43 is produced and validated against the committed
 * contract copies in packages/api/contracts. */
import { afterEach, beforeEach, describe, it } from 'vitest'
import { check } from './support/contract.js'
import { ADMIN_ONLY, READER } from './support/fake-keycloak.js'
import { signIn, withSession } from './support/harness.js'
import {
  createSettingsHarness,
  NEVER_SEEN_APP_ID,
  SEED_VERSION_ID,
  WORKDAY,
  type SettingsHarness,
} from './support/settings-harness.js'

const SETTINGS = '/api/v1/detection-settings'
const THRESHOLD = `${SETTINGS}/thresholds/{thresholdKey}`
const APPS = `${SETTINGS}/sensitive-apps`
const SEARCH = `${SETTINGS}/tenant-apps`

let h: SettingsHarness
let admin: Record<string, string>
let reader: Record<string, string>

/* The first app a worker builds can take seconds under coverage instrumentation. */
beforeEach(async () => {
  h = createSettingsHarness()
  admin = withSession((await signIn(h, ADMIN_ONLY)).session)
  reader = withSession((await signIn(h, READER)).session)
}, 30_000)

afterEach(async () => {
  await h.app.close()
})

const tighten = (cookies: Record<string, string>, body: object) =>
  h.app.inject({
    method: 'PUT',
    url: `${SETTINGS}/thresholds/repeated_failures`,
    cookies,
    payload: { configVersionId: SEED_VERSION_ID, count: 8, windowMinutes: 60, ...body },
  })

const addApp = (cookies: Record<string, string>, appId: string) =>
  h.app.inject({ method: 'POST', url: APPS, cookies, payload: { configVersionId: SEED_VERSION_ID, appId } })

describe('IF-40 GET /api/v1/detection-settings', () => {
  it('200 matches the contract, with a sensitive app listed', async () => {
    await addApp(admin, WORKDAY.appId)
    check('IF-40', SETTINGS, 'get', await h.app.inject({ url: SETTINGS, cookies: admin }))
  })

  it('401 matches the contract', async () => {
    check('IF-40', SETTINGS, 'get', await h.app.inject({ url: SETTINGS }))
  })

  it('403 matches the contract', async () => {
    check('IF-40', SETTINGS, 'get', await h.app.inject({ url: SETTINGS, cookies: reader }))
  })

  it('503 matches the contract', async () => {
    h.settings.failReads = true
    check('IF-40', SETTINGS, 'get', await h.app.inject({ url: SETTINGS, cookies: admin }))
  })
})

describe('IF-41 PUT /api/v1/detection-settings/thresholds/{thresholdKey}', () => {
  it('200 matches the contract', async () => {
    check('IF-41', THRESHOLD, 'put', await tighten(admin, {}))
  })

  it('400 matches the contract', async () => {
    check('IF-41', THRESHOLD, 'put', await tighten(admin, { count: 0 }))
  })

  it('401 matches the contract', async () => {
    check('IF-41', THRESHOLD, 'put', await tighten({}, {}))
  })

  it('403 matches the contract', async () => {
    check('IF-41', THRESHOLD, 'put', await tighten(reader, {}))
  })

  it('409 matches the contract', async () => {
    check('IF-41', THRESHOLD, 'put', await tighten(admin, { count: 12 }))
  })

  it('503 matches the contract', async () => {
    h.settings.failWrites = true
    check('IF-41', THRESHOLD, 'put', await tighten(admin, {}))
  })
})

describe('IF-42 POST /api/v1/detection-settings/sensitive-apps', () => {
  it('201 matches the contract', async () => {
    check('IF-42', APPS, 'post', await addApp(admin, WORKDAY.appId))
  })

  it('400 matches the contract', async () => {
    check('IF-42', APPS, 'post', await addApp(admin, 'not-an-id'))
  })

  it('401 matches the contract', async () => {
    check('IF-42', APPS, 'post', await addApp({}, WORKDAY.appId))
  })

  it('403 matches the contract', async () => {
    check('IF-42', APPS, 'post', await addApp(reader, WORKDAY.appId))
  })

  it('409 matches the contract', async () => {
    await addApp(admin, WORKDAY.appId)
    check('IF-42', APPS, 'post', await addApp(admin, WORKDAY.appId))
  })

  it('422 matches the contract', async () => {
    check('IF-42', APPS, 'post', await addApp(admin, NEVER_SEEN_APP_ID))
  })

  it('503 matches the contract', async () => {
    h.settings.failWrites = true
    check('IF-42', APPS, 'post', await addApp(admin, WORKDAY.appId))
  })
})

describe('IF-43 GET /api/v1/detection-settings/tenant-apps', () => {
  it('200 matches the contract', async () => {
    check('IF-43', SEARCH, 'get', await h.app.inject({ url: `${SEARCH}?q=work`, cookies: admin }))
  })

  it('400 matches the contract', async () => {
    check('IF-43', SEARCH, 'get', await h.app.inject({ url: `${SEARCH}?q=${'x'.repeat(101)}`, cookies: admin }))
  })

  it('401 matches the contract', async () => {
    check('IF-43', SEARCH, 'get', await h.app.inject({ url: `${SEARCH}?q=work` }))
  })

  it('403 matches the contract', async () => {
    check('IF-43', SEARCH, 'get', await h.app.inject({ url: `${SEARCH}?q=work`, cookies: reader }))
  })

  it('503 matches the contract', async () => {
    h.tenantApps.fail = true
    check('IF-43', SEARCH, 'get', await h.app.inject({ url: `${SEARCH}?q=work`, cookies: admin }))
  })
})
