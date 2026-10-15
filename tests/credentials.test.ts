import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { encryptCredentials, decryptCredentials } from '../src/services/credentials.service.ts'
import { loadConfig } from '../src/config.ts'
import { openDatabase } from '../src/database.ts'

const key = randomBytes(32)
const environment = { NODE_ENV: 'development', CREDENTIAL_ENCRYPTION_KEY: key.toString('base64') }

test('password and private-key credentials survive encryption without plaintext exposure', () => {
  for (const credentials of [
    { sshPassword: 'secret-password-marker' },
    { sshPrivateKey: 'private-key-secret-marker', sshPrivateKeyPassphrase: 'secret-passphrase-marker' },
    { sshPrivateKey: 'unprotected-private-key-marker' },
  ]) {
    const ciphertext = encryptCredentials(key, 'computer-1', 'owner-1', credentials)
    assert.deepEqual(decryptCredentials(key, 'computer-1', 'owner-1', ciphertext), credentials)
    for (const value of Object.values(credentials)) assert.equal(ciphertext.includes(value), false)
  }
})

test('a fresh nonce gives different ciphertext for the same credentials', () => {
  const credentials = { sshPassword: 'same-password' }
  assert.notEqual(encryptCredentials(key, 'computer-1', 'owner-1', credentials), encryptCredentials(key, 'computer-1', 'owner-1', credentials))
})

test('changed payload, another key or another computer or owner fails authentication', () => {
  const ciphertext = encryptCredentials(key, 'computer-1', 'owner-1', { sshPassword: 'secret' })
  const bytes = Buffer.from(ciphertext, 'base64')
  for (const offset of [0, 1, 12, 20, bytes.length - 1]) {
    const tampered = Buffer.from(bytes)
    tampered[offset] ^= 1
    assert.throws(() => decryptCredentials(key, 'computer-1', 'owner-1', tampered.toString('base64')))
  }
  assert.throws(() => decryptCredentials(key, 'computer-2', 'owner-1', ciphertext))
  assert.throws(() => decryptCredentials(key, 'computer-1', 'owner-2', ciphertext))
  assert.throws(() => decryptCredentials(randomBytes(32), 'computer-1', 'owner-1', ciphertext))
  assert.throws(() => decryptCredentials(key, 'computer-1', 'owner-1', 'invalid'))
})

test('encryption refuses keys with the wrong size and oversized credentials', () => {
  assert.throws(() => encryptCredentials(Buffer.alloc(31), 'computer-1', 'owner-1', { sshPassword: 'secret' }))
  assert.throws(() => encryptCredentials(key, 'computer-1', 'owner-1', { sshPassword: 'a'.repeat(32769) }))
})

test('missing, malformed, or wrong-length encryption keys stop configuration loading', () => {
  for (const value of [undefined, '', 'garbage', randomBytes(31).toString('base64'), randomBytes(33).toString('base64')]) {
    assert.throws(() => loadConfig({ NODE_ENV: 'development', CREDENTIAL_ENCRYPTION_KEY: value }))
  }
  assert.deepEqual(loadConfig(environment).credentialEncryptionKey, key)
})

test('production requires an exact HTTPS frontend origin and secure cookies', () => {
  assert.throws(() => loadConfig({ ...environment, NODE_ENV: 'production' }))
  for (const origin of ['*', 'http://example.com', 'https://example.com/path', 'https://example.com/', 'https://user@example.com']) {
    assert.throws(() => loadConfig({ ...environment, NODE_ENV: 'production', FRONTEND_ORIGIN: origin }))
  }
  const config = loadConfig({ ...environment, NODE_ENV: 'production', FRONTEND_ORIGIN: 'https://example.com' })
  assert.equal(config.secureCookies, true)
  assert.equal(config.frontendOrigin, 'https://example.com')
  assert.throws(() => loadConfig({ ...environment, NODE_ENV: 'staging' }))
})

test('explicit development supplies local defaults and rejects invalid ports', () => {
  const config = loadConfig(environment)
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.secureCookies, false)
  assert.equal(config.frontendOrigin, 'http://localhost:5173')
  for (const port of ['0', '65536', '3.5', 'abc', '']) assert.throws(() => loadConfig({ ...environment, PORT: port }))
})

test('database enables WAL, initializes tables and enforces owner foreign keys', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lightning-db-'))
  const db = openDatabase(join(directory, 'nested', 'test.sqlite'))
  try {
    assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal')
    assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1)
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name), ['auth_limits', 'computers', 'schema_migrations', 'sessions', 'users'])
    assert.throws(() => db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run('hash', 'missing-user', Date.now()))
    db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run('owner-1', 'a@example.com', 'salt:hash', '2026-10-14T00:00:00.000Z')
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run('hash', 'owner-1', Date.now())
    assert.throws(() => db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run('owner-2', 'a@example.com', 'salt:hash', '2026-10-14T00:00:00.000Z'))
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'index' AND name IN ('sessions_expires_at_idx', 'computers_owner_id_idx')").get()?.count, 2)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
