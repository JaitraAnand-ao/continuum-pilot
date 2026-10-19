/* Server-side session port (AD-5). Rows hold the SHA-256 of the session ID, never the ID itself,
 * and the refresh and ID tokens only as AES-256-GCM ciphertext. */
import type { Role } from './roles'

export interface StoredSession {
  idHash: string
  account: string
  displayName: string
  roles: Role[]
  authTime: Date
  createdAt: Date
  lastSeenAt: Date
  refreshToken: string | null
  idToken: string
}

export interface SessionStore {
  create(session: StoredSession): Promise<void>
  find(idHash: string): Promise<StoredSession | undefined>
  touch(idHash: string, at: Date): Promise<void>
  remove(idHash: string): Promise<void>
}

export interface MemorySessionStore extends SessionStore {
  rows(): StoredSession[]
}

export function createMemorySessionStore(): MemorySessionStore {
  const rows = new Map<string, StoredSession>()
  return {
    rows: () => [...rows.values()].map((row) => ({ ...row })),
    async create(session) {
      rows.set(session.idHash, { ...session })
    },
    async find(idHash) {
      const row = rows.get(idHash)
      return row === undefined ? undefined : { ...row }
    },
    async touch(idHash, at) {
      const row = rows.get(idHash)
      if (row !== undefined) row.lastSeenAt = at
    },
    async remove(idHash) {
      rows.delete(idHash)
    },
  }
}
