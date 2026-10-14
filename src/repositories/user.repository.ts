import type { DatabaseSync } from 'node:sqlite'
import type { User } from '../types.js'

export class UserRepository {
  constructor(private readonly db: DatabaseSync) {}
  findByEmail(email: string): User | null {
    return this.map(this.db.prepare('SELECT * FROM users WHERE email = ?').get(email))
  }
  findById(id: string): User | null {
    return this.map(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id))
  }
  create(user: User): void {
    this.db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run(user.id, user.email, user.passwordHash, user.createdAt)
  }
  private map(row: Record<string, unknown> | undefined): User | null {
    return row ? { id: String(row.id), email: String(row.email), passwordHash: String(row.password_hash), createdAt: String(row.created_at) } : null
  }
}
