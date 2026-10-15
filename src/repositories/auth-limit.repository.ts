import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export type AuthLimitScope = 'ip' | 'login'
const WINDOW_MS = 60_000
const BAN_MS = 15 * 60_000
const MAX_ATTEMPTS = 10
const MAX_ENTRIES = 10_000

export class AuthLimitRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Atomically admit an attempt, or return the remaining wait in seconds. */
  consume(scope: AuthLimitScope, subject: string, now: number): number | null {
    const hash = createHash('sha256').update(subject).digest('hex')
    // The write lock covers read/check/update across all processes using this file.
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM auth_limits WHERE expires_at <= ?').run(now)
      const row = this.db.prepare('SELECT attempts, expires_at, banned FROM auth_limits WHERE scope = ? AND subject_hash = ?').get(scope, hash)
      let retryAfter: number | null = null
      if (row?.banned) {
        retryAfter = Math.max(1, Math.ceil((Number(row.expires_at) - now) / 1000))
      } else if (row && Number(row.attempts) >= MAX_ATTEMPTS) {
        this.db.prepare('UPDATE auth_limits SET banned = 1, expires_at = ? WHERE scope = ? AND subject_hash = ?').run(now + BAN_MS, scope, hash)
        retryAfter = BAN_MS / 1000
      } else if (row) {
        this.db.prepare('UPDATE auth_limits SET attempts = attempts + 1 WHERE scope = ? AND subject_hash = ?').run(scope, hash)
      } else if (Number(this.db.prepare('SELECT count(*) AS count FROM auth_limits').get()!.count) >= MAX_ENTRIES) {
        // Never evict active bans to make room for attacker-controlled identities.
        retryAfter = Math.max(1, Math.ceil((Number(this.db.prepare('SELECT min(expires_at) AS expiry FROM auth_limits').get()!.expiry) - now) / 1000))
      } else {
        this.db.prepare('INSERT INTO auth_limits(scope, subject_hash, attempts, expires_at, banned) VALUES (?, ?, 1, ?, 0)').run(scope, hash, now + WINDOW_MS)
      }
      this.db.exec('COMMIT')
      return retryAfter
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
