import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { normalizeSshUsername } from './ssh-username.js'

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const database = new DatabaseSync(path)
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS auth_limits (
        scope TEXT NOT NULL CHECK (scope IN ('ip', 'login')),
        subject_hash TEXT NOT NULL,
        attempts INTEGER NOT NULL CHECK (attempts >= 1),
        expires_at INTEGER NOT NULL,
        banned INTEGER NOT NULL CHECK (banned IN (0, 1)),
        PRIMARY KEY (scope, subject_hash)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS auth_limits_expires_at_idx ON auth_limits(expires_at);
      CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY) STRICT;
      CREATE TABLE IF NOT EXISTS computers (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        color TEXT,
        os TEXT NOT NULL DEFAULT 'linux' CHECK (os IN ('linux', 'windows')),
        ip_address TEXT NOT NULL,
        mac_address TEXT NOT NULL,
        broadcast_address TEXT NOT NULL,
        ssh_port INTEGER NOT NULL DEFAULT 22 CHECK (ssh_port BETWEEN 1 AND 65535),
        wol_port INTEGER NOT NULL DEFAULT 9 CHECK (wol_port BETWEEN 1 AND 65535),
        ssh_username TEXT NOT NULL,
        ssh_host_key_fingerprint TEXT NOT NULL,
        encrypted_credentials TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS computers_owner_id_idx ON computers(owner_id);
    `)
    // Additive migration preserves IDs and credential ciphertext/AAD for legacy files.
    if (!database.prepare('PRAGMA table_info(computers)').all().some(column => column.name === 'color')) {
      database.exec('ALTER TABLE computers ADD COLUMN color TEXT')
    }
    database.exec('BEGIN IMMEDIATE')
    try {
      if (!database.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get('normalize-ssh-usernames')) {
        // node:sqlite can truncate TEXT at NUL on read; reject it in SQL first.
        if (database.prepare('SELECT 1 FROM computers WHERE instr(ssh_username, char(0)) > 0 LIMIT 1').get()) throw new Error('Invalid SSH username')
        const update = database.prepare('UPDATE computers SET ssh_username = ? WHERE id = ?')
        for (const row of database.prepare('SELECT id, ssh_username FROM computers').all()) {
          // IDs and ciphertext stay intact: credential AAD does not include the name.
          const username = normalizeSshUsername(row.ssh_username)
          if (username !== row.ssh_username) update.run(username, String(row.id))
        }
        database.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run('normalize-ssh-usernames')
      }
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
