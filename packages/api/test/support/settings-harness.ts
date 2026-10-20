/* The BFF with ST-15's detection settings wired to in-memory adapters: a config-version store seeded with the
 * out-of-the-box version, and the applications seen in the tenant's sign-ins. */
import { buildApp } from '../../src/app.js'
import { InMemoryAuditLog } from '../../src/audit.js'
import { createOidcClient } from '../../src/auth/oidc.js'
import { loadConfig } from '../../src/config.js'
import { InMemorySessionStore } from '../../src/session/store.js'
import { initialVersion } from '../../src/settings/rules.js'
import { InMemoryDetectionSettingsStore, InMemoryTenantAppDirectory } from '../../src/settings/store.js'
import { createFakeKeycloak } from './fake-keycloak.js'
import { FakeReportHistoryStore } from './report-history-store.js'
import { TEST_ENV, TestClock, type Harness } from './harness.js'

export const SEED_VERSION_ID = '0b9a4c1e-5f2d-4e8a-9c3b-7d6e5f4a3b21'
export const SEEDED_AT = '2026-10-01T00:00:00.000Z'
export const WORKDAY = { appId: '6c1f6a2e-3b7d-4f1e-9a35-0d7f4b2c9e11', appName: 'Workday' }
export const SALESFORCE = { appId: 'a3e5c7d9-1b2f-4a6c-8e0d-2f4b6d8a0c13', appName: 'Salesforce' }
export const WORKPLACE = { appId: 'f1e2d3c4-b5a6-4978-8695-a4b3c2d1e0f9', appName: 'Workplace Analytics' }
export const NEVER_SEEN_APP_ID = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a'

export interface SettingsHarness extends Harness {
  settings: InMemoryDetectionSettingsStore
  tenantApps: InMemoryTenantAppDirectory
}

export function createSettingsHarness(start = '2026-10-12T09:30:00.000Z'): SettingsHarness {
  const clock = new TestClock(new Date(start))
  const keycloak = createFakeKeycloak(() => clock.now())
  const config = loadConfig(TEST_ENV)
  const sessions = new InMemorySessionStore()
  const audit = new InMemoryAuditLog()
  const reports = new FakeReportHistoryStore()
  const oidc = createOidcClient({
    issuer: config.oidc.issuer,
    clientId: config.oidc.clientId,
    clientSecret: config.oidc.clientSecret,
    redirectUri: `${config.publicOrigin}/auth/callback`,
    idpHint: config.oidc.idpHint,
    fetch: keycloak.fetch,
    clock,
  })
  const settings = new InMemoryDetectionSettingsStore(initialVersion(SEED_VERSION_ID, new Date(SEEDED_AT)))
  const tenantApps = new InMemoryTenantAppDirectory([WORKDAY, SALESFORCE, WORKPLACE])
  const app = buildApp({ config, clock, sessions, audit, oidc, reportHistory: reports, settings, tenantApps })
  return { app, clock, keycloak, sessions, audit, reports, settings, tenantApps }
}
