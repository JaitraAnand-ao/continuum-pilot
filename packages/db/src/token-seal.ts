/* AD-5: the session and transaction IDs are stored only as SHA-256; the refresh token and the
 * PKCE verifier only as AES-256-GCM ciphertext, bound by AAD to the row that holds them. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export interface Sealed {
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
}

const KEY_BYTES = 32
const IV_BYTES = 12

export function hashSecret(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function checkKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new RangeError(`AES-256-GCM needs a ${KEY_BYTES}-byte key`)
}

export function seal(key: Buffer, plaintext: string, aad: Buffer): Sealed {
  checkKey(key)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return { ciphertext, iv, tag: cipher.getAuthTag() }
}

export function open(key: Buffer, sealed: Sealed, aad: Buffer): string {
  checkKey(key)
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv).setAAD(aad).setAuthTag(sealed.tag)
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8')
}
