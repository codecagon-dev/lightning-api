import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import type { Config } from '../config.js'
import type { User } from '../types.js'
import { UserRepository } from '../repositories/user.repository.js'
import { SessionRepository } from '../repositories/session.repository.js'

export interface UserSession { userId: string; sessionId: string; expiresAt: number }
export class ApiError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 502 | 504, message: string) { super(message) }
}
export interface AuthOptions { now?: () => number; maxConcurrentScrypt?: number }
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')

export class AuthService {
  private readonly now: () => number
  private readonly maxConcurrent: number
  private active = 0
  private readonly listeners = new Set<(sessionId: string) => void>()
  constructor(private readonly users: UserRepository, private readonly sessions: SessionRepository, private readonly config: Config, options: AuthOptions = {}) {
    this.now = options.now ?? Date.now
    this.maxConcurrent = options.maxConcurrentScrypt ?? 4
    if (!Number.isInteger(this.maxConcurrent) || this.maxConcurrent < 1 || this.maxConcurrent > 16) throw new Error('Invalid password hashing concurrency')
  }
  async register(email: string, password: string): Promise<{ user: User; token: string }> {
    email = this.validate(email, password)
    if (this.users.findByEmail(email)) throw new ApiError(409, 'Email already registered')
    const salt = randomBytes(16)
    const key = await this.derive(password, salt)
    const user: User = { id: randomUUID(), email, passwordHash: `scrypt$${salt.toString('hex')}$${key.toString('hex')}`, createdAt: new Date(this.now()).toISOString() }
    // Recheck after asynchronous hashing to cover simultaneous registrations.
    if (this.users.findByEmail(email)) throw new ApiError(409, 'Email already registered')
    this.users.create(user)
    return { user, token: this.createSession(user.id) }
  }
  async login(email: string, password: string): Promise<{ user: User; token: string }> {
    email = this.validate(email, password)
    const user = this.users.findByEmail(email)
    const parts = user?.passwordHash.split('$')
    const validHash = parts?.length === 3 && parts[0] === 'scrypt' && /^[a-f0-9]{32}$/.test(parts[1]!) && /^[a-f0-9]{128}$/.test(parts[2]!)
    const salt = validHash ? Buffer.from(parts![1]!, 'hex') : Buffer.alloc(16)
    const expected = validHash ? Buffer.from(parts![2]!, 'hex') : Buffer.alloc(64)
    const actual = await this.derive(password, salt)
    if (!timingSafeEqual(actual, expected) || !user || !validHash) throw new ApiError(401, 'Invalid email or password')
    return { user, token: this.createSession(user.id) }
  }
  authenticate(token: string): UserSession | null {
    this.cleanupExpired()
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
    const session = this.sessions.find(tokenHash(token))
    return session ? { userId: session.userId, sessionId: session.tokenHash, expiresAt: session.expiresAt } : null
  }
  logout(token: string): void {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return
    const id = tokenHash(token)
    if (this.sessions.delete(id)) this.notify(id)
  }
  onRevoke(listener: (sessionId: string) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  cleanupExpired(): void { for (const id of this.sessions.deleteExpired(this.now())) this.notify(id) }
  getUser(userId: string): User | null { return this.users.findById(userId) }
  private notify(id: string): void {
    for (const listener of this.listeners) { try { listener(id) } catch { /* One subscriber must not prevent revocation. */ } }
  }
  private createSession(userId: string): string {
    this.cleanupExpired()
    const token = randomBytes(32).toString('base64url')
    this.sessions.create({ tokenHash: tokenHash(token), userId, expiresAt: this.now() + this.config.sessionLifetimeMs })
    return token
  }
  private validate(email: string, password: string): string {
    if (typeof email !== 'string' || typeof password !== 'string') throw new ApiError(400, 'Invalid email or password format')
    email = email.trim().toLowerCase()
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || password.length > 128) throw new ApiError(400, 'Invalid email or password format')
    return email
  }
  private async derive(password: string, salt: Buffer): Promise<Buffer> {
    if (this.active >= this.maxConcurrent) throw new ApiError(429, 'Too many requests')
    this.active++
    try { return await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, SCRYPT_OPTIONS, (error, key) => error ? reject(error) : resolve(key))) }
    finally { this.active-- }
  }
}
