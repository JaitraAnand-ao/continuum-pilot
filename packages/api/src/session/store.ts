/* Server-side sessions (AD-5). A row holds the SHA-256 of the cookie value and the sealed refresh token, never either in clear. */
import type { Role } from '../auth/roles.js'

export interface SessionRecord {
  idHash: string
  subject: string
  account: string
  displayName: string
  roles: Role[]
  authTime: Date
  createdAt: Date
  lastSeenAt: Date
  refreshTokenSealed: string | null
}

export interface SessionStore {
  insert(record: SessionRecord): Promise<void>
  find(idHash: string): Promise<SessionRecord | undefined>
  touch(idHash: string, lastSeenAt: Date): Promise<void>
  remove(idHash: string): Promise<void>
}

export class InMemorySessionStore implements SessionStore {
  readonly #rows = new Map<string, SessionRecord>()

  async insert(record: SessionRecord): Promise<void> {
    this.#rows.set(record.idHash, { ...record })
  }

  async find(idHash: string): Promise<SessionRecord | undefined> {
    const row = this.#rows.get(idHash)
    return row && { ...row }
  }

  async touch(idHash: string, lastSeenAt: Date): Promise<void> {
    const row = this.#rows.get(idHash)
    if (row) row.lastSeenAt = lastSeenAt
  }

  async remove(idHash: string): Promise<void> {
    this.#rows.delete(idHash)
  }

  /* What a database would hold, for tests to inspect. */
  rows(): SessionRecord[] {
    return [...this.#rows.values()].map((row) => ({ ...row }))
  }
}
