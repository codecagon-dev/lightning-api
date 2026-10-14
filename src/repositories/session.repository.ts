import type { DatabaseSync } from 'node:sqlite'
import type { Session } from '../types.js'

export class SessionRepository {
  constructor(private readonly db: DatabaseSync) {}
  create(session: Session): void {
    this.db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(session.tokenHash, session.userId, session.expiresAt)
  }
  find(tokenHash: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash)
    return row ? { tokenHash: String(row.token_hash), userId: String(row.user_id), expiresAt: Number(row.expires_at) } : null
  }
  delete(tokenHash: string): boolean {
    return this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash).changes > 0
  }
  deleteExpired(now: number): string[] {
    const rows = this.db.prepare('DELETE FROM sessions WHERE expires_at <= ? RETURNING token_hash').all(now)
    return rows.map(row => String(row.token_hash))
  }
}
