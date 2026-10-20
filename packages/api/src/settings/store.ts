/* Ports for ST-15: the append-only config-version store and the applications seen in the tenant's stored sign-ins.
 * The Postgres adapters land with CMP-5; these in-memory ones hold what the tables would. */
import type { ConfigVersion } from './rules.js'

export interface DetectionSettingsStore {
  current(): Promise<ConfigVersion>
  /* Appends next only while next.previousId is still the current version; false means another save got there first. */
  append(next: ConfigVersion): Promise<boolean>
}

export interface TenantApp {
  appId: string
  appName: string
}

/* Application IDs cross this port in canonical lower case, whatever case Graph or a paste used. */
export interface TenantAppDirectory {
  find(appId: string): Promise<TenantApp | undefined>
  /* Matches the name case-insensitively or the application ID by prefix, ordered by name. */
  search(query: string, limit: number): Promise<TenantApp[]>
}

function copy(version: ConfigVersion): ConfigVersion {
  return structuredClone(version)
}

export class InMemoryDetectionSettingsStore implements DetectionSettingsStore {
  readonly #versions: ConfigVersion[]
  failReads = false
  failWrites = false
  /* Lets a test land a competing version between a route's read and its append. */
  raceNextWrite = false

  constructor(seed: ConfigVersion) {
    this.#versions = [copy(seed)]
  }

  async current(): Promise<ConfigVersion> {
    if (this.failReads) throw new Error('settings store offline')
    return copy(this.#versions.at(-1)!)
  }

  async append(next: ConfigVersion): Promise<boolean> {
    if (this.failWrites) throw new Error('settings store offline')
    if (this.raceNextWrite) {
      this.raceNextWrite = false
      const head = this.#versions.at(-1)!
      this.#versions.push({ ...copy(head), id: `${head.id}-raced`, previousId: head.id })
    }
    if (next.previousId !== this.#versions.at(-1)!.id) return false
    this.#versions.push(copy(next))
    return true
  }

  /* Every version ever written, oldest first, for tests to inspect. */
  versions(): ConfigVersion[] {
    return this.#versions.map(copy)
  }
}

export class InMemoryTenantAppDirectory implements TenantAppDirectory {
  readonly #apps: TenantApp[]
  fail = false

  constructor(apps: readonly TenantApp[]) {
    this.#apps = apps
      .map((app) => ({ ...app, appId: app.appId.toLowerCase() }))
      .sort((a, b) => a.appName.localeCompare(b.appName))
  }

  async find(appId: string): Promise<TenantApp | undefined> {
    if (this.fail) throw new Error('sign-in store offline')
    const app = this.#apps.find((one) => one.appId === appId.toLowerCase())
    return app && { ...app }
  }

  async search(query: string, limit: number): Promise<TenantApp[]> {
    if (this.fail) throw new Error('sign-in store offline')
    const needle = query.toLowerCase()
    return this.#apps
      .filter((app) => app.appName.toLowerCase().includes(needle) || app.appId.startsWith(needle))
      .slice(0, limit)
      .map((app) => ({ ...app }))
  }
}
