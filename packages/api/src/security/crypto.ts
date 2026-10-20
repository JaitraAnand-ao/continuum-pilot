/* AD-5 primitives: opaque random IDs, SHA-256 session ID hashes, AES-256-GCM sealing and the PKCE S256 challenge. */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'

const IV_BYTES = 12
const TAG_BYTES = 16

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex')
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export interface DerivedKeys {
  transaction: Buffer
  refreshToken: Buffer
}

/* One configured master key, separate keys per purpose so a sealed transaction cookie never opens as a token. */
export function deriveKeys(master: Buffer): DerivedKeys {
  if (master.length !== 32) throw new Error('the session master key must be 32 bytes')
  const derive = (info: string) => Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, 32))
  return { transaction: derive('sr-login-transaction'), refreshToken: derive('sr-refresh-token') }
}

/* AES-256-GCM, IV || ciphertext || tag in base64url; `binding` is authenticated data tying the ciphertext to its use. */
export function seal(key: Buffer, plaintext: string, binding: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(binding))
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url')
}

export function unseal(key: Buffer, sealed: string, binding: string): string | null {
  const bytes = Buffer.from(sealed, 'base64url')
  if (bytes.length < IV_BYTES + TAG_BYTES) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, IV_BYTES))
    decipher.setAAD(Buffer.from(binding))
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES))
    return Buffer.concat([
      decipher.update(bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    return null
  }
}
