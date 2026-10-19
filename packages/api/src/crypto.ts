/* AD-5 primitives: opaque random IDs, SHA-256 at rest, PKCE S256 and AES-256-GCM sealing. */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const IV_BYTES = 12
const TAG_BYTES = 16

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function seal(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')
}

/* Returns null for a wrong key, a short value or any tampered byte. */
export function open(key: Buffer, sealed: string): string | null {
  const bytes = Buffer.from(sealed, 'base64url')
  if (bytes.length < IV_BYTES + TAG_BYTES) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, IV_BYTES))
    decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
    return Buffer.concat([decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
