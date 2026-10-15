import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createUserCommand, readPassword } from '../src/cli/create-user.js'
import { openDatabase } from '../src/database.js'
import { loadConfig } from '../src/config.js'
import { AuthService } from '../src/services/auth.service.js'
import { UserRepository } from '../src/repositories/user.repository.js'
import { SessionRepository } from '../src/repositories/session.repository.js'
import { AuthLimitRepository } from '../src/repositories/auth-limit.repository.js'

const password = '  local test password  '
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'lightning-create-user-'))
  const path = join(directory, 'accounts.sqlite')
  const env = { NODE_ENV: 'development', DATABASE_PATH: path, CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64') }
  return { path, env, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

test('local provisioning persists a normalized account with a hashed password, but no session', async () => {
  const f = fixture()
  try {
    let prompts = 0
    await createUserCommand([' Operator@EXAMPLE.com '], f.env, async () => { prompts++; return password })
    assert.equal(prompts, 2)
    const db = openDatabase(f.path)
    try {
      const user = new UserRepository(db).findByEmail('operator@example.com')!
      assert.ok(user)
      assert.equal(user.passwordHash.includes(password), false)
      assert.equal(db.prepare('SELECT count(*) AS count FROM sessions').get()!.count, 0)
      const auth = new AuthService(new UserRepository(db), new SessionRepository(db), loadConfig(f.env), new AuthLimitRepository(db))
      assert.equal((await auth.login('OPERATOR@example.com', password)).user.id, user.id)
      await assert.rejects(auth.login('operator@example.com', password.trim()), { status: 401 })
      await assert.rejects(createUserCommand(['operator@example.com'], f.env, async () => 'another long password'), { status: 409 })
      assert.equal(new UserRepository(db).findByEmail('operator@example.com')!.passwordHash, user.passwordHash)
    } finally { db.close() }
  } finally { f.cleanup() }
})

test('local provisioning rejects mismatches, invalid credentials and memory-only storage without an account', async () => {
  const f = fixture()
  try {
    let prompts = 0
    await assert.rejects(createUserCommand(['operator@example.com'], f.env, async () => ++prompts === 1 ? password : 'different password'), /Passwords do not match/)
    assert.equal(existsSync(f.path), false)
    await assert.rejects(createUserCommand(['operator@example.com'], { ...f.env, DATABASE_PATH: ':memory:' }, async () => password), /persistent/)
    await assert.rejects(createUserCommand(['operator@example.com'], f.env, async () => 'short'), { status: 400 })
    await assert.rejects(createUserCommand(['not-an-email'], f.env, async () => password), { status: 400 })
    const db = openDatabase(f.path)
    try { assert.equal(db.prepare('SELECT count(*) AS count FROM users').get()!.count, 0) }
    finally { db.close() }
  } finally { f.cleanup() }
})

test('hidden terminal input never echoes the password and restores terminal mode on completion or cancel', async () => {
  for (const cancel of [false, true]) {
    const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(value: boolean) { this.isRaw = value; return this } })
    const output = Object.assign(new PassThrough(), { isTTY: true })
    let displayed = ''
    output.on('data', chunk => { displayed += chunk.toString() })
    const result = readPassword('Password: ', input as any, output as any)
    assert.equal(input.isRaw, true)
    const completion = cancel ? assert.rejects(result, /cancelled/i) : result.then(value => assert.equal(value, password))
    input.write(cancel ? '\x03' : password + '\r')
    await completion
    assert.equal(displayed, 'Password: \n')
    assert.equal(input.isRaw, false)
    input.destroy(); output.destroy()
  }
})

test('the executable rejects password arguments and noninteractive input without exposing secrets or creating a database', () => {
  const f = fixture()
  try {
    const env = { ...process.env, ...f.env }
    delete env.NODE_TEST_CONTEXT
    delete env.NODE_OPTIONS
    const cli = fileURLToPath(new URL('../src/cli/create-user.ts', import.meta.url))
    for (const args of [['operator@example.com', '--password', password], ['operator@example.com']]) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], { env, encoding: 'utf8', input: password })
      assert.ifError(result.error)
      assert.equal(result.status, 1)
      const output = result.stdout + result.stderr
      assert.equal(output.includes(password), false)
      assert.match(output, args.length > 1 ? /Usage:/ : /interactive terminal/)
      assert.equal(existsSync(f.path), false)
    }
  } finally { f.cleanup() }
})
