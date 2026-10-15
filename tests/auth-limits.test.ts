import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/database.js'
import { AuthLimitRepository } from '../src/repositories/auth-limit.repository.js'

test('attempts and bans are shared by database connections and survive closing and reopening', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lightning-limits-'))
  const path = join(directory, 'test.sqlite')
  let db = openDatabase(path)
  const other = openDatabase(path)
  try {
    let first = new AuthLimitRepository(db)
    const second = new AuthLimitRepository(other)
    for (let i = 0; i < 9; i++) assert.equal((i % 2 ? first : second).consume('ip', '192.0.2.1', 1000), null)
    db.close(); db = openDatabase(path); first = new AuthLimitRepository(db)
    assert.equal(first.consume('ip', '192.0.2.1', 1000), null)
    assert.equal(second.consume('ip', '192.0.2.1', 1000), 900)
    db.close(); db = openDatabase(path); first = new AuthLimitRepository(db)
    assert.equal(first.consume('ip', '192.0.2.1', 61000), 840)
    assert.equal(second.consume('ip', '192.0.2.1', 900999), 1)
    assert.equal(first.consume('ip', '192.0.2.1', 901000), null)
    assert.equal(second.consume('ip', '192.0.2.2', 901000), null)
  } finally { other.close(); db.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('ordinary windows expire, scopes are independent and stored identifiers do not contain raw IPs or emails', () => {
  const db = openDatabase(':memory:')
  try {
    const limits = new AuthLimitRepository(db)
    for (let i = 0; i < 10; i++) assert.equal(limits.consume('login', 'person@example.com', 0), null)
    assert.equal(limits.consume('login', 'person@example.com', 60000), null)
    assert.equal(limits.consume('ip', '192.0.2.1', 60000), null)
    for (let i = 1; i < 10; i++) assert.equal(limits.consume('ip', '192.0.2.1', 60000), null)
    assert.equal(limits.consume('ip', '192.0.2.1', 60000), 900)
    assert.equal(limits.consume('login', '192.0.2.1', 60000), null)
    const rows = JSON.stringify(db.prepare('SELECT * FROM auth_limits').all())
    assert.equal(rows.includes('person@example.com'), false)
    assert.equal(rows.includes('192.0.2.1'), false)
  } finally { db.close() }
})

test('capacity rejects new identities without evicting bans, but expiration frees space', () => {
  const db = openDatabase(':memory:')
  try {
    db.exec(`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<10000)
      INSERT INTO auth_limits SELECT 'ip', printf('%064x', n), 10, 900000, 1 FROM ids`)
    const limits = new AuthLimitRepository(db)
    assert.equal(limits.consume('ip', 'new-client', 0), 900)
    assert.equal(db.prepare('SELECT count(*) AS count FROM auth_limits').get()!.count, 10000)
    assert.equal(limits.consume('ip', 'new-client', 900000), null)
    assert.equal(db.prepare('SELECT count(*) AS count FROM auth_limits').get()!.count, 1)
  } finally { db.close() }
})
