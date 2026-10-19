/* The session store port (AD-5): a row holds the SHA-256 hash of the session ID, never the ID, and the
 * refresh token only as AES-256-GCM ciphertext. */
import type { AppRole } from '../auth/roles.js'

export interface SessionRecord {
  idHash: string
  account: string
  displayName: string
  roles: AppRole[]
  authTime: Date
  createdAt: Date
  lastSeenAt: Date
  refreshTokenCiphertext: string
}

export interface SessionStore {
  create(record: SessionRecord): Promise<void>
  find(idHash: string): Promise<SessionRecord | undefined>
  touch(idHash: string, at: Date): Promise<void>
  delete(idHash: string): Promise<void>
}

export class InMemorySessionStore implements SessionStore {
  readonly rows = new Map<string, SessionRecord>()

  async create(record: SessionRecord): Promise<void> {
    this.rows.set(record.idHash, { ...record, roles: [...record.roles] })
  }

  async find(idHash: string): Promise<SessionRecord | undefined> {
    const row = this.rows.get(idHash)
    return row && { ...row, roles: [...row.roles] }
  }

  async touch(idHash: string, at: Date): Promise<void> {
    const row = this.rows.get(idHash)
    if (row) row.lastSeenAt = at
  }

  async delete(idHash: string): Promise<void> {
    this.rows.delete(idHash)
  }
}
