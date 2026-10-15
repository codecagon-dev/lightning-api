import { AuthLimitRepository } from '../src/repositories/auth-limit.repository.js'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { openDatabase } from '../src/database.js'
import { AuthService, ApiError } from '../src/services/auth.service.js'
import { UserRepository } from '../src/repositories/user.repository.js'
import { SessionRepository } from '../src/repositories/session.repository.js'
import { createLogger, startupFailure } from '../src/logging.js'

test('HTTP logs final statuses and route templates without request or error secrets', async () => {
  const lines: string[] = []
  const logger = createLogger(line => lines.push(line))
  const config = loadConfig({ NODE_ENV: 'development', CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openDatabase(':memory:')
  try {
    const authService = new AuthService(new UserRepository(db), new SessionRepository(db), config, new AuthLimitRepository(db))
    const app = createApp({ config, authService, logger, registerRoutes: app => {
      app.get('/ok/:id', c => c.json({ ok: true }))
      app.get('/expected', () => { throw new ApiError(401, 'secret-error') })
      app.get('/broken', () => { throw Object.assign(new Error('secret-error'), { code: 'secret-code' }) })
      app.post('/body', c => c.json({ ok: true }))
    } })
    for (const [path, init, status] of [
      ['/ok/secret-id?password=secret-query', { headers: { cookie: 'secret-cookie' } }, 200],
      ['/expected', {}, 401], ['/broken', {}, 500], ['/secret-unknown?secret-query', {}, 404],
      ['/ok/secret-id', { headers: { origin: 'https://secret-origin' } }, 403],
      ['/body', { method: 'POST', body: 'secret-body'.repeat(10000) }, 413],
    ] as const) assert.equal((await app.request(path, init)).status, status)
    const entries = lines.map(line => JSON.parse(line))
    const requests = entries.filter(e => e.event === 'http_request')
    assert.deepEqual(requests.map(e => e.statusCode), [200, 401, 500, 404, 403, 413])
    assert.deepEqual(requests.map(e => e.route), ['/ok/:id', '/expected', '/broken', '<unmatched>', '/ok/:id', '/body'])
    assert.equal(entries.filter(e => e.event === 'internal_error').length, 1)
    for (const entry of requests) {
      assert.equal(typeof entry.durationMs, 'number')
      assert.ok(entry.durationMs >= 0)
      assert.ok(Number.isFinite(Date.parse(entry.timestamp)))
      assert.ok(['info', 'warn', 'error'].includes(entry.level))
    }
    assert.equal(lines.join('').includes('secret'), false)
  } finally { db.close() }
})

test('startup failures expose only fixed actionable diagnostics and allowlisted codes', () => {
  let error: unknown
  try { loadConfig({ FRONTEND_ORIGIN: 'http://secret.example', CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64') }) } catch (caught) { error = caught }
  assert.match(startupFailure(error).message, /FRONTEND_ORIGIN.*HTTPS/)
  assert.equal(startupFailure(Object.assign(new Error('secret path'), { code: 'EADDRINUSE' })).reason, 'EADDRINUSE')
  assert.equal(startupFailure(Object.assign(new Error('secret'), { code: 'SQLITE_CANTOPEN' })).reason, 'SQLITE_CANTOPEN')
  assert.equal(startupFailure(Object.assign(new Error('secret'), { code: 'ERR_SQLITE_ERROR', errcode: 14 })).reason, 'SQLITE_CANTOPEN')
  assert.deepEqual(startupFailure(new Error('FRONTEND_ORIGIN secret')), { reason: 'unknown', message: 'Startup failed; check configuration and database availability' })
  assert.equal(JSON.stringify(startupFailure(Object.assign(new Error('secret'), { code: 'secret' }))).includes('secret'), false)
})

test('sink failures cannot change HTTP success or sanitized errors', async () => {
  const config = loadConfig({ NODE_ENV: 'development', CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openDatabase(':memory:')
  try {
    const authService = new AuthService(new UserRepository(db), new SessionRepository(db), config, new AuthLimitRepository(db))
    for (const logger of [createLogger(() => { throw new Error('sink secret') }), { log() { throw new Error('sink secret') } }]) {
      const app = createApp({ config, authService, logger, registerRoutes: app => {
        app.get('/ok', c => c.json({ ok: true }))
        app.get('/broken', () => { throw new Error('client secret') })
      } })
      assert.equal((await app.request('/ok')).status, 200)
      const broken = await app.request('/broken')
      assert.equal(broken.status, 500)
      assert.deepEqual(await broken.json(), { error: 'Internal server error' })
    }
  } finally { db.close() }
})

for (const stream of ['stdout', 'stderr'] as const) test(`closed ${stream} cannot crash logging or expose an error stack`, { timeout: 5000 }, async () => {
  const moduleUrl = new URL('../src/logging.ts', import.meta.url).href
  const script = `
    import { createLogger } from ${JSON.stringify(moduleUrl)};
    setTimeout(() => {
      for (let i = 0; i < 20; i++) createLogger().log('${stream === 'stdout' ? 'info' : 'error'}', {event:'startup'});
      setTimeout(() => {}, 30);
    }, 100);
  `
  const childEnv = { ...process.env }
  delete childEnv.NODE_TEST_CONTEXT
  delete childEnv.NODE_OPTIONS
  // A real OS pipe with its reader closed exercises asynchronous EPIPE.
  // pipefail preserves Node's exit status if it crashes after head exits.
  const command = stream === 'stdout'
    ? '"$1" --input-type=module -e "$2" | head -n 0'
    : '"$1" --input-type=module -e "$2" 2>&1 >/dev/null | head -n 0'
  const child = spawn('bash', ['-o', 'pipefail', '-c', command, 'logging-pipe', process.execPath, script], {
    stdio: ['ignore', 'pipe', 'pipe'], env: childEnv,
  })
  let diagnostics = ''
  child.stdout.on('data', chunk => { diagnostics += chunk.toString() })
  child.stderr.on('data', chunk => { diagnostics += chunk.toString() })
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  assert.equal(exitCode, 0, diagnostics)
  assert.equal(diagnostics, '', 'no raw stack or recursive fallback output')
})
