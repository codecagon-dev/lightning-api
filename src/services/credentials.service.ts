import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Credentials } from '../types.js'

const CREDENTIAL_LIMIT_BYTES = 32 * 1024
const VERSION = 1
const NONCE_BYTES = 12
const TAG_BYTES = 16

function associatedData(computerId: string, ownerId: string): Buffer {
  return Buffer.from(JSON.stringify(['lightning-credentials-v1', computerId, ownerId]))
}

function validateCredentials(value: unknown): asserts value is Credentials {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid credentials')
  const payload = value as Record<string, unknown>
  const keys = Object.keys(payload)
  const password = keys.length === 1 && typeof payload.sshPassword === 'string' && payload.sshPassword.length > 0
  const privateKey = typeof payload.sshPrivateKey === 'string' && payload.sshPrivateKey.length > 0
    && keys.every(key => key === 'sshPrivateKey' || key === 'sshPrivateKeyPassphrase')
    && (!('sshPrivateKeyPassphrase' in payload) || typeof payload.sshPrivateKeyPassphrase === 'string')
  if (!password && !privateKey) throw new Error('Invalid credentials')
}

export function encryptCredentials(key: Buffer, computerId: string, ownerId: string, credentials: Credentials): string {
  if (key.length !== 32) throw new Error('Invalid encryption key')
  validateCredentials(credentials)
  const plaintext = Buffer.from(JSON.stringify(credentials))
  if (plaintext.length > CREDENTIAL_LIMIT_BYTES) throw new Error('Credentials exceed size limit')
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(associatedData(computerId, ownerId))
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([Buffer.from([VERSION]), nonce, cipher.getAuthTag(), encrypted]).toString('base64')
}

export function decryptCredentials(key: Buffer, computerId: string, ownerId: string, ciphertext: string): Credentials {
  try {
    if (key.length !== 32 || ciphertext.length > Math.ceil((1 + NONCE_BYTES + TAG_BYTES + CREDENTIAL_LIMIT_BYTES) / 3) * 4) throw new Error()
    const payload = Buffer.from(ciphertext, 'base64')
    if (payload.toString('base64') !== ciphertext || payload.length <= 1 + NONCE_BYTES + TAG_BYTES || payload[0] !== VERSION) throw new Error()
    const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(1, 1 + NONCE_BYTES))
    decipher.setAAD(associatedData(computerId, ownerId))
    decipher.setAuthTag(payload.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES))
    const plaintext = Buffer.concat([decipher.update(payload.subarray(1 + NONCE_BYTES + TAG_BYTES)), decipher.final()])
    const credentials: unknown = JSON.parse(plaintext.toString('utf8'))
    validateCredentials(credentials)
    return credentials
  } catch {
    throw new Error('Unable to decrypt credentials')
  }
}
