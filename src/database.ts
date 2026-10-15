import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
