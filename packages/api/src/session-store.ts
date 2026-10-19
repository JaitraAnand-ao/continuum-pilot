/* The session store port. A row holds only the SHA-256 hash of the session ID and the AES-256-GCM ciphertext of
 * the refresh token (AD-5); the cookie value itself is never stored. */
import type { Role } from './roles.js'

export interface StoredSession {
  idHash: string
  subject: string
  account: string
  displayName: string
  roles: Role[]
  authTime: Date
  createdAt: Date
  lastSeenAt: Date
  refreshTokenCiphertext: string | null
}

export interface SessionStore {
  create(session: StoredSession): Promise<void>
  findByHash(idHash: string): Promise<StoredSession | undefined>
  touch(idHash: string, at: Date): Promise<void>
  delete(idHash: string): Promise<void>
}

/* The in-process adapter, used until CMP-5 commits the sessions table. */
export class InMemorySessionStore implements SessionStore {
  readonly rows = new Map<string, StoredSession>()

  async create(session: StoredSession): Promise<void> {
    this.rows.set(session.idHash, { ...session })
  }

  async findByHash(idHash: string): Promise<StoredSession | undefined> {
    const row = this.rows.get(idHash)
    return row === undefined ? undefined : { ...row }
  }

  async touch(idHash: string, at: Date): Promise<void> {
    const row = this.rows.get(idHash)
    if (row !== undefined) row.lastSeenAt = at
  }

  async delete(idHash: string): Promise<void> {
    this.rows.delete(idHash)
  }
}
