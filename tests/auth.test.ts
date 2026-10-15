import { createAndLogin } from './helpers.js'
import { AuthLimitRepository } from '../src/repositories/auth-limit.repository.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase } from '../src/database.js'
import { loadConfig } from '../src/config.js'
import { UserRepository } from '../src/repositories/user.repository.js'
import { SessionRepository } from '../src/repositories/session.repository.js'
import { AuthService } from '../src/services/auth.service.js'
import { createApp } from '../src/app.js'

function fixture(options: { limit?: number; mode?: 'development' | 'production' } = {}) {
  const db = openDatabase(':memory:')
  const config = loadConfig({ NODE_ENV: options.mode ?? 'production', FRONTEND_ORIGIN: options.mode === 'development' ? 'http://localhost:5173' : 'https://app.example', CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64') })
  let time = 1000
  const auth = new AuthService(new UserRepository(db), new SessionRepository(db), config, new AuthLimitRepository(db), { now: () => time, maxConcurrentScrypt: options.limit ?? 4 })
  let ip = '192.0.2.1'
  const app = createApp({ config, authService: auth, clientIp: () => ip, now: () => time, registerRoutes: app => { app.get('/failure', () => { throw new Error('secret failure detail') }) } })
  return { db, auth, app, config, advance: (ms: number) => { time += ms }, setIp: (value: string) => { ip = value } }
}
const password = 'a long password!'
const post = (app: ReturnType<typeof createApp>, path: string, body: unknown, headers = {}) => app.request(`/auth/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

test('public registration is unavailable and cannot create accounts or sessions', async () => {
  const f = fixture()
  try {
    for (const path of ['/auth/register', '/auth/register/']) {
      const response = await f.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'uninvited@example.com', password }) })
      assert.equal(response.status, 404)
      assert.equal(response.headers.get('set-cookie'), null)
    }
    assert.equal(f.db.prepare('SELECT count(*) AS count FROM users').get()!.count, 0)
    assert.equal(f.db.prepare('SELECT count(*) AS count FROM sessions').get()!.count, 0)
  } finally { f.db.close() }
})

test('local provisioning normalizes unique emails, hashes passwords with unique salts and stores only hashed tokens', async () => {
  const f = fixture()
  try {
    const { user, token } = await createAndLogin(f.auth, ' Person@Example.COM ', password)
    assert.equal(user.email, 'person@example.com')
    assert.equal(Buffer.from(token, 'base64url').length, 32)
    assert.equal(f.auth.authenticate(token)?.userId, user.id)
    await assert.rejects(createAndLogin(f.auth, 'person@example.com', password))
    const other = await createAndLogin(f.auth, 'other@example.com', password)
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
    const first = await createAndLogin(f.auth, 'a@example.com', password)
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
    await f.auth.createUser('a@example.com', password)
    const response = await post(f.app, 'login', { email: 'a@example.com', password }, { origin: 'https://app.example' })
    assert.equal(response.status, 200)
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

test('login uses non-Secure cookies for local HTTP and Secure cookies in production', async () => {
  for (const mode of ['development', 'production'] as const) {
    const f = fixture({ mode })
    try {
      await f.auth.createUser('local@example.com', password)
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await post(f.app, 'login', { email: 'local@example.com', password }, { origin: f.config.frontendOrigin })
        assert.equal(response.status, 200)
        const cookie = response.headers.get('set-cookie')!
        for (const flag of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=604800']) assert.ok(cookie.includes(flag), flag)
        assert.equal(/;\s*Secure(?:;|$)/i.test(cookie), mode === 'production')
        const me = await f.app.request('/auth/me', { headers: { origin: f.config.frontendOrigin, cookie: cookie.split(';')[0] } })
        assert.equal(me.status, 200)
        assert.equal((await me.json()).user.email, 'local@example.com')
      }
    } finally { f.db.close() }
  }
})

test('Origin is exact, credentialed CORS is limited, and no-Origin requests work', async () => {
  const f = fixture()
  try {
    await f.auth.createUser('a@example.com', password)
    for (const origin of ['https://evil.example', 'null', 'https://app.example/']) assert.equal((await post(f.app, 'login', { email: 'a@example.com', password }, { origin })).status, 403)
    const preflight = await f.app.request('/auth/login', { method: 'OPTIONS', headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' } })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://app.example')
    assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true')
    assert.equal(preflight.headers.get('access-control-expose-headers'), 'Retry-After')
    assert.equal((await post(f.app, 'login', { email: 'a@example.com', password })).status, 200)
  } finally { f.db.close() }
})

test('invalid inputs and oversized bodies are rejected; unexpected errors are sanitized', async () => {
  const f = fixture()
  try {
    for (const body of [{ email: 'bad', password }, { email: 'a@example.com', password: 'short' }, { email: 'a@example.com', password: 'x'.repeat(129) }, { email: 'a@example.com', password, extra: true }]) assert.equal((await post(f.app, 'login', body)).status, 400)
    assert.equal((await post(f.app, 'login', { email: 'a@example.com', password: 'x'.repeat(70000) })).status, 413)
    const malformed = await f.app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
    assert.equal(malformed.status, 400)
    const failure = await f.app.request('/failure')
    assert.equal(failure.status, 500)
    assert.ok(!(await failure.text()).includes('secret'))
  } finally { f.db.close() }
})

test('login enforces a persistent IP ban, ignores forwarded headers and expires without extending the ban', async () => {
  const f = fixture()
  try {
    for (let i = 0; i < 10; i++) assert.equal((await post(f.app, 'login', {}, { 'x-forwarded-for': `192.0.2.${i + 2}` })).status, 400)
    const blocked = await post(f.app, 'login', {})
    assert.equal(blocked.status, 429)
    assert.equal(blocked.headers.get('retry-after'), '900')
    const restarted = createApp({ config: f.config, authService: f.auth, clientIp: () => '192.0.2.1', now: () => 1000 })
    assert.equal((await post(restarted, 'login', {})).status, 429)
    f.setIp('192.0.2.99')
    assert.equal((await post(f.app, 'login', {})).status, 400)
    f.setIp('192.0.2.1'); f.advance(60000)
    const stillBlocked = await post(f.app, 'login', {})
    assert.equal(stillBlocked.status, 429)
    assert.equal(stillBlocked.headers.get('retry-after'), '840')
    f.advance(840000)
    assert.equal((await post(f.app, 'login', {})).status, 400)
  } finally { f.db.close() }
})

test('login-name limits resist IP rotation and casing changes, including nonexistent accounts', async () => {
  const f = fixture()
  try {
    for (let i = 0; i < 10; i++) {
      f.setIp(`192.0.2.${i + 1}`)
      assert.equal((await post(f.app, 'login', { email: i % 2 ? ' Missing@EXAMPLE.com ' : 'missing@example.com', password })).status, 401)
    }
    f.setIp('192.0.2.99')
    const blocked = await post(f.app, 'login', { email: 'MISSING@example.com', password })
    assert.equal(blocked.status, 429)
    assert.equal(blocked.headers.get('retry-after'), '900')
    assert.equal((await post(f.app, 'login', { email: 'unrelated@example.com', password })).status, 401)
    f.advance(900000)
    assert.equal((await post(f.app, 'login', { email: 'missing@example.com', password })).status, 401)
  } finally { f.db.close() }
})

test('concurrent password hashing rejects excess work rather than queuing unbounded jobs', async () => {
  const f = fixture({ limit: 1 })
  try {
    const first = createAndLogin(f.auth, 'a@example.com', password)
    await assert.rejects(createAndLogin(f.auth, 'b@example.com', password), /Too many requests/)
    await first
    assert.equal((await createAndLogin(f.auth, 'b@example.com', password)).user.email, 'b@example.com')
  } finally { f.db.close() }
})

test('concurrent login attempts reserve their budget before hashing; bans preserve existing sessions', async () => {
  const f = fixture({ limit: 16 })
  try {
    const registered = await createAndLogin(f.auth, 'person@example.com', password)
    f.advance(60000)
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => f.auth.login('PERSON@example.com', 'wrong password!')))
    const statuses = attempts.map(result => result.status === 'rejected' ? result.reason.status : 200)
    assert.equal(statuses.filter(status => status === 401).length, 10)
    assert.equal(statuses.filter(status => status === 429).length, 2)
    await assert.rejects(f.auth.login('person@example.com', password), { status: 429, retryAfter: 900 })
    assert.equal(f.auth.authenticate(registered.token)?.userId, registered.user.id)
    f.advance(900000)
    assert.equal((await f.auth.login('person@example.com', password)).user.id, registered.user.id)
  } finally { f.db.close() }
})

test('rate-limit storage failures deny authentication with a sanitized response', async () => {
  const f = fixture()
  try {
    await createAndLogin(f.auth, 'person@example.com', password)
    f.db.exec('DROP TABLE auth_limits')
    const response = await post(f.app, 'login', { email: 'person@example.com', password })
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: 'Internal server error' })
    assert.equal(response.headers.get('set-cookie'), null)
    assert.equal(f.db.prepare('SELECT count(*) AS count FROM sessions').get()!.count, 1)
  } finally { f.db.close() }
})
