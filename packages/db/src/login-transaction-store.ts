/* AD-5 login transaction: what the BFF must remember between the redirect to Keycloak and the
 * callback, keyed by the Lax transaction cookie. State and nonce are kept only as SHA-256, the
 * PKCE verifier only sealed; a transaction is consumed once, whatever the outcome. */
import { timingSafeEqual } from 'node:crypto'
import { eq, lte } from 'drizzle-orm'
import type { Clock } from './clock.js'
import { guarded, type Database } from './database.js'
import { loginTransactions } from './schema.js'
import { hashSecret, type Sealed } from './token-seal.js'

export const LOGIN_TRANSACTION_LIMIT_MS = 10 * 60_000

export interface NewLoginTransaction {
  transactionId: string
  state: string
  nonce: string
  codeVerifier: Sealed
}

export interface ConsumedLoginTransaction {
  codeVerifier: Sealed
  matchesNonce(nonce: string): boolean
}

const sameHash = (value: string, stored: Buffer) => timingSafeEqual(hashSecret(value), stored)

export function createLoginTransactionStore(db: Database, clock: Clock) {
  return guarded({
    async begin(transaction: NewLoginTransaction): Promise<void> {
      await db.insert(loginTransactions).values({
        idHash: hashSecret(transaction.transactionId),
        stateHash: hashSecret(transaction.state),
        nonceHash: hashSecret(transaction.nonce),
        codeVerifierCiphertext: transaction.codeVerifier.ciphertext,
        codeVerifierIv: transaction.codeVerifier.iv,
        codeVerifierTag: transaction.codeVerifier.tag,
        expiresAt: new Date(clock.now().getTime() + LOGIN_TRANSACTION_LIMIT_MS),
      })
    },

    /** Removes the transaction and returns it only when it is unexpired and the returned state matches. */
    async consume(callback: { transactionId: string; state: string }): Promise<ConsumedLoginTransaction | null> {
      const now = clock.now()
      const [row] = await db
        .delete(loginTransactions)
        .where(eq(loginTransactions.idHash, hashSecret(callback.transactionId)))
        .returning()
      if (!row || row.expiresAt <= now || !sameHash(callback.state, row.stateHash)) return null
      return {
        codeVerifier: { ciphertext: row.codeVerifierCiphertext, iv: row.codeVerifierIv, tag: row.codeVerifierTag },
        matchesNonce: (nonce) => sameHash(nonce, row.nonceHash),
      }
    },

    async purgeExpired(): Promise<number> {
      const purged = await db
        .delete(loginTransactions)
        .where(lte(loginTransactions.expiresAt, clock.now()))
        .returning({ idHash: loginTransactions.idHash })
      return purged.length
    },
  })
}

export type LoginTransactionStore = ReturnType<typeof createLoginTransactionStore>
