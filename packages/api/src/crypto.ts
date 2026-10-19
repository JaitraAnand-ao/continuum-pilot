/* AD-5 primitives: opaque random values, SHA-256 hashing of session IDs, PKCE S256, and AES-256-GCM sealing. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

const VERSION = 'v1'

/* Sealed form: v1.<iv>.<tag>.<ciphertext>, each base64url. */
export function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.')
}

export class SealError extends Error {
  constructor() {
    super('sealed value is malformed or was tampered with')
    this.name = 'SealError'
  }
}

export function unseal(sealed: string, key: Buffer): string {
  const [version, iv, tag, ciphertext, ...rest] = sealed.split('.')
  if (version !== VERSION || iv === undefined || tag === undefined || ciphertext === undefined || rest.length > 0) {
    throw new SealError()
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    throw new SealError()
  }
}
