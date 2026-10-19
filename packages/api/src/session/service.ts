/* Opens, resolves and ends server-side sessions over the store, applying the AD-5 limits on the injected clock. */
import type { Role } from '../auth/roles.js'
import type { Clock } from '../clock.js'
import { hashSessionId, randomToken, seal, unseal } from '../security/crypto.js'
import { sessionStatus } from './policy.js'
import type { SessionRecord, SessionStore } from './store.js'

export interface NewSession {
  subject: string
  account: string
  displayName: string
  roles: Role[]
  authTime: Date
  refreshToken: string | undefined
}

export class SessionService {
  constructor(
    private readonly store: SessionStore,
    private readonly clock: Clock,
    private readonly refreshTokenKey: Buffer,
  ) {}

  /* Returns the cookie value; only its hash is stored, and the refresh token only sealed and bound to that hash. */
  async open(session: NewSession): Promise<{ sessionId: string; record: SessionRecord }> {
    const sessionId = randomToken()
    const idHash = hashSessionId(sessionId)
    const now = this.clock.now()
    const record: SessionRecord = {
      idHash,
      subject: session.subject,
      account: session.account,
      displayName: session.displayName,
      roles: session.roles,
      authTime: session.authTime,
      createdAt: now,
      lastSeenAt: now,
      refreshTokenSealed:
        session.refreshToken === undefined ? null : seal(this.refreshTokenKey, session.refreshToken, idHash),
    }
    await this.store.insert(record)
    return { sessionId, record }
  }

  /* An active session counts this request as activity; an expired one is deleted. */
  async resolve(sessionId: string | undefined): Promise<SessionRecord | null> {
    if (!sessionId) return null
    const idHash = hashSessionId(sessionId)
    const record = await this.store.find(idHash)
    if (!record) return null
    const now = this.clock.now()
    if (sessionStatus(record, now) !== 'active') {
      await this.store.remove(idHash)
      return null
    }
    await this.store.touch(idHash, now)
    return { ...record, lastSeenAt: now }
  }

  /* Deletes the session whatever its state and hands back the refresh token so the caller can end it at Keycloak. */
  async end(sessionId: string | undefined): Promise<{ refreshToken: string | null }> {
    if (!sessionId) return { refreshToken: null }
    const idHash = hashSessionId(sessionId)
    const record = await this.store.find(idHash)
    await this.store.remove(idHash)
    const sealed = record?.refreshTokenSealed
    return { refreshToken: sealed ? unseal(this.refreshTokenKey, sealed, idHash) : null }
  }
}
