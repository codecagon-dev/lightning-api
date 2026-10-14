import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase } from '../src/database.js'
import { loadConfig } from '../src/config.js'
import { UserRepository } from '../src/repositories/user.repository.js'
import { SessionRepository } from '../src/repositories/session.repository.js'
import { AuthService } from '../src/services/auth.service.js'
import { createApp } from '../src/app.js'

function fixture(options: { limit?: number } = {}) {
  const db = openDatabase(':memory:')
  const config = loadConfig({ FRONTEND_ORIGIN: 'https://app.example', CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64') })
  let time = 1000
  const auth = new AuthService(new UserRepository(db), new SessionRepository(db), config, { now: () => time, maxConcurrentScrypt: options.limit ?? 4 })
  let ip = '192.0.2.1'
  const app = createApp({ config, authService: auth, clientIp: () => ip, now: () => time, registerRoutes: app => { app.get('/failure', () => { throw new Error('secret failure detail') }) } })
  return { db, auth, app, config, advance: (ms: number) => { time += ms }, setIp: (value: string) => { ip = value } }
}
const password = 'a long password!'
const post = (app: ReturnType<typeof createApp>, path: string, body: unknown, headers = {}) => app.request(`/auth/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

test('registration normalizes unique emails, hashes passwords with unique salts and stores only hashed tokens', async () => {
  const f = fixture()
  try {
    const { user, token } = await f.auth.register(' Person@Example.COM ', password)
    assert.equal(user.email, 'person@example.com')
    assert.equal(Buffer.from(token, 'base64url').length, 32)
    assert.equal(f.auth.authenticate(token)?.userId, user.id)
    await assert.rejects(f.auth.register('person@example.com', password))
    const other = await f.auth.register('other@example.com', password)
    assert.notEqual(other.user.passwordHash, user.passwordHash)
    const rows = JSON.stringify({ users: f.db.prepare('SELECT * FROM users').all(), sessions: f.db.prepare('SELECT * FROM sessions').all() })
    assert.ok(!rows.includes(password))
    assert.ok(!rows.includes(token))
    assert.equal((await f.auth.login('PERSON@example.com', password)).user.id, user.id)
    await assert.rejects(f.auth.login('person@example.com', 'incorrect password'), /Invalid email or password/)
    await assert.rejects(f.auth.login('missing@example.com', password), /Invalid email or password/)
  } finally { f.db.close() }
})

test('logout and expiry revoke sessions observably and cleanup expired rows', async () => {
  const f = fixture()
  try {
    const revoked: string[] = []
    f.auth.onRevoke(id => revoked.push(id))
    const first = await f.auth.register('a@example.com', password)
    const id = f.auth.authenticate(first.token)!.sessionId
    f.auth.logout(first.token)
    assert.equal(f.auth.authenticate(first.token), null)
    assert.deepEqual(revoked, [id])
    const second = await f.auth.login('a@example.com', password)
    const secondId = f.auth.authenticate(second.token)!.sessionId
    f.advance(7 * 24 * 60 * 60 * 1000)
    assert.equal(f.auth.authenticate(second.token), null)
    assert.deepEqual(revoked, [id, secondId])
    assert.equal(f.db.prepare('SELECT count(*) AS count FROM sessions').get()!.count, 0)
  } finally { f.db.close() }
})

test('HTTP auth sets strict secure cookies and exposes only public user fields', async () => {
  const f = fixture()
  try {
    const response = await post(f.app, 'register', { email: 'a@example.com', password }, { origin: 'https://app.example' })
    assert.equal(response.status, 201)
    const body = await response.json()
    assert.deepEqual(Object.keys(body.user).sort(), ['email', 'id'])
    const cookie = response.headers.get('set-cookie')!
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=604800']) assert.ok(cookie.includes(flag), flag)
    const headers = { cookie: cookie.split(';')[0] }
    assert.equal((await f.app.request('/auth/me', { headers })).status, 200)
    const logout = await post(f.app, 'logout', {}, headers)
    assert.equal(logout.status, 204)
    assert.equal(await logout.text(), '')
    assert.ok(logout.headers.get('set-cookie')?.includes('Max-Age=0'))
    assert.equal((await f.app.request('/auth/me', { headers })).status, 401)
    assert.equal((await post(f.app, 'login', { email: 'a@example.com', password })).status, 200)
  } finally { f.db.close() }
})

test('Origin is exact, credentialed CORS is limited, and no-Origin requests work', async () => {
  const f = fixture()
  try {
    for (const origin of ['https://evil.example', 'null', 'https://app.example/']) assert.equal((await post(f.app, 'register', { email: 'a@example.com', password }, { origin })).status, 403)
    const preflight = await f.app.request('/auth/login', { method: 'OPTIONS', headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' } })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://app.example')
    assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true')
    assert.equal((await post(f.app, 'register', { email: 'a@example.com', password })).status, 201)
  } finally { f.db.close() }
})

test('invalid inputs and oversized bodies are rejected; unexpected errors are sanitized', async () => {
  const f = fixture()
  try {
    for (const body of [{ email: 'bad', password }, { email: 'a@example.com', password: 'short' }, { email: 'a@example.com', password: 'x'.repeat(129) }, { email: 'a@example.com', password, extra: true }]) assert.equal((await post(f.app, 'register', body)).status, 400)
    assert.equal((await post(f.app, 'register', { email: 'a@example.com', password: 'x'.repeat(70000) })).status, 413)
    const malformed = await f.app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
    assert.equal(malformed.status, 400)
    const failure = await f.app.request('/failure')
    assert.equal(failure.status, 500)
    assert.ok(!(await failure.text()).includes('secret'))
  } finally { f.db.close() }
})

test('register/login share direct-IP rate limit without trusting forwarded headers and reset after a minute', async () => {
  const f = fixture()
  try {
    for (let i = 0; i < 10; i++) assert.equal((await post(f.app, i % 2 ? 'login' : 'register', {}, { 'x-forwarded-for': `192.0.2.${i + 2}` })).status, 400)
    assert.equal((await post(f.app, 'login', {})).status, 429)
    f.setIp('192.0.2.99')
    assert.equal((await post(f.app, 'login', {})).status, 400)
    f.setIp('192.0.2.1'); f.advance(60000)
    assert.equal((await post(f.app, 'login', {})).status, 400)
  } finally { f.db.close() }
})

test('concurrent password hashing rejects excess work rather than queuing unbounded jobs', async () => {
  const f = fixture({ limit: 1 })
  try {
    const first = f.auth.register('a@example.com', password)
    await assert.rejects(f.auth.register('b@example.com', password), /Too many requests/)
    await first
    assert.equal((await f.auth.register('b@example.com', password)).user.email, 'b@example.com')
  } finally { f.db.close() }
})
