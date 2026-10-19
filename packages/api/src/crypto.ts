/* AD-5 primitives: opaque random identifiers, the SHA-256 session-ID hash, AES-256-GCM sealing and the PKCE S256 challenge. */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Secret } from './secret.js'

const IV_BYTES = 12
const TAG_BYTES = 16

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

/* iv || tag || ciphertext, base64url; the AAD binds a ciphertext to its purpose or its session. */
export function seal(key: Secret<Buffer>, plaintext: string, aad: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key.reveal(), iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')
}

export function open(key: Secret<Buffer>, sealed: string, aad: string): string | undefined {
  const raw = Buffer.from(sealed, 'base64url')
  if (raw.length < IV_BYTES + TAG_BYTES) return undefined
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.reveal(), raw.subarray(0, IV_BYTES))
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8')
  } catch {
    return undefined
  }
}
