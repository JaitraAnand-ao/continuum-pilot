/* The session port. Rows hold the SHA-256 of the session ID and the sealed refresh token, never either in clear. */
import type { Role } from '../access.js'

export interface StoredSession {
  idHash: string
  refreshTokenCiphertext: string
  account: string
  displayName: string
  roles: Role[]
  authTime: Date
  createdAt: Date
  lastSeenAt: Date
}

export interface SessionStore {
  create(session: StoredSession): Promise<void>
  find(idHash: string): Promise<StoredSession | undefined>
  touch(idHash: string, at: Date): Promise<void>
  delete(idHash: string): Promise<void>
}

/** For tests and local runs; the Postgres store arrives with the CMP-5 sessions table. */
export class InMemorySessionStore implements SessionStore {
  private readonly byHash = new Map<string, StoredSession>()

  async create(session: StoredSession): Promise<void> {
    this.byHash.set(session.idHash, { ...session })
  }

  async find(idHash: string): Promise<StoredSession | undefined> {
    const session = this.byHash.get(idHash)
    return session === undefined ? undefined : { ...session }
  }

  async touch(idHash: string, at: Date): Promise<void> {
    const session = this.byHash.get(idHash)
    if (session !== undefined) session.lastSeenAt = at
  }

  async delete(idHash: string): Promise<void> {
    this.byHash.delete(idHash)
  }

  rows(): StoredSession[] {
    return [...this.byHash.values()].map((session) => ({ ...session }))
  }
}
