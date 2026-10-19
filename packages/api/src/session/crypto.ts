/* AD-5: opaque session IDs stored only as SHA-256, and secrets sealed with AES-256-GCM. */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'

const IV_BYTES = 12
const TAG_BYTES = 16

export type SealPurpose = 'refresh-token' | 'login-transaction'

export function newSessionId(): string {
  return randomBytes(32).toString('base64url')
}

export function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex')
}

/** A purpose-bound 256-bit key, so one leaked use cannot open another. */
export function deriveKey(master: Buffer, purpose: SealPurpose): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `signin-reports/${purpose}`, 32))
}

/** base64url(iv | ciphertext | tag), with the purpose as associated data. */
export function sealToken(key: Buffer, plaintext: string, purpose: SealPurpose): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(purpose))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64url')
}

/** Throws when the value was not sealed with this key for this purpose, or was altered. */
export function openToken(key: Buffer, sealed: string, purpose: SealPurpose): string {
  const bytes = Buffer.from(sealed, 'base64url')
  if (bytes.length < IV_BYTES + TAG_BYTES) throw new Error('sealed value is too short')
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, IV_BYTES))
  decipher.setAAD(Buffer.from(purpose))
  decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES))
  return Buffer.concat([
    decipher.update(bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8')
}
