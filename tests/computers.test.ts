import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { openDatabase } from '../src/database.js'
import { loadConfig } from '../src/config.js'
import { UserRepository } from '../src/repositories/user.repository.js'
import { SessionRepository } from '../src/repositories/session.repository.js'
import { AuthService } from '../src/services/auth.service.js'
import { encryptCredentials, decryptCredentials } from '../src/services/credentials.service.js'
import { ComputerRepository, toPublicComputer } from '../src/repositories/computer.repository.js'
import { computersRoutes, parseComputerInput } from '../src/routes/computers.js'
import type { ComputerStatus } from '../src/types.js'
import { createApp } from '../src/app.js'

const fingerprint = `SHA256:${Buffer.alloc(32, 7).toString('base64').replace(/=+$/, '')}`
const input = { name: 'Office', ipAddress: '192.168.1.20', macAddress: 'aA-Bb-cc-DD-ee-Ff', broadcastAddress: '192.168.1.255', sshUsername: 'operator', sshHostKeyFingerprint: fingerprint, sshPassword: 'ssh-secret-for-computer' }
async function fixture() {
  const db = openDatabase(':memory:')
  const config = loadConfig({ FRONTEND_ORIGIN: 'https://app.example', CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 42).toString('base64') })
  const auth = new AuthService(new UserRepository(db), new SessionRepository(db), config)
  const a = await auth.register('a@example.com', 'a long password!')
  const b = await auth.register('b@example.com', 'a long password!')
  const repo = new ComputerRepository(db, (id, owner, credentials) => encryptCredentials(config.credentialEncryptionKey, id, owner, credentials))
  const snapshots: string[] = []
  const statuses = new Map<string, ComputerStatus>()
  const app = createApp({ config, authService: auth, registerRoutes: app => app.route('/computers', computersRoutes({ repository: repo, authService: auth, config, status: { get: id => statuses.get(id) ?? { status: 'unknown', checkedAt: null, sshStatus: 'unknown', sshCheckedAt: null } }, onRegistered: owner => { snapshots.push(owner) } })) })
  const headers = (token: string) => ({ cookie: `${config.sessionCookieName}=${token}` })
  const post = (body: unknown, token = a.token) => app.request('/computers', { method: 'POST', headers: { ...headers(token), 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { db, repo, config, auth, app, a, b, snapshots, statuses, post, headers }
}

test('registration defaults Linux/ports, normalizes MAC, binds encrypted secrets and publishes owner snapshot', async () => {
  const f = await fixture()
  try {
    const response = await f.post(input)
    assert.equal(response.status, 201)
    const { computer } = await response.json()
    assert.equal(computer.os, 'linux')
    assert.equal(computer.sshPort, 22)
    assert.equal(computer.wolPort, 9)
    assert.equal(computer.macAddress, 'aa:bb:cc:dd:ee:ff')
    assert.equal(computer.status, 'unknown')
    assert.equal(computer.checkedAt, null)
    assert.match(computer.id, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
    assert.ok(Number.isFinite(Date.parse(computer.createdAt)))
    assert.deepEqual(Object.keys(computer).sort(), ['id','name','color','os','ipAddress','macAddress','broadcastAddress','sshPort','wolPort','sshUsername','sshHostKeyFingerprint','createdAt','status','checkedAt','sshStatus','sshCheckedAt'].sort())
    const saved = f.repo.findOwned(f.a.user.id, computer.id)!
    assert.deepEqual(decryptCredentials(f.config.credentialEncryptionKey, saved.id, saved.ownerId, saved.encryptedCredentials), { sshPassword: input.sshPassword })
    assert.equal(f.repo.findOwned(f.b.user.id, computer.id), null)
    assert.equal(f.repo.findOwned(f.a.user.id, 'missing'), null)
    assert.deepEqual(f.snapshots, [f.a.user.id])
    const database = JSON.stringify(f.db.prepare('SELECT * FROM computers').all())
    assert.ok(!database.includes(input.sshPassword))
    assert.ok(!JSON.stringify(computer).includes(input.sshPassword))
  } finally { f.db.close() }
})

test('Windows/private keys/passphrases and custom ports persist; listings isolate owners and use latest status', async () => {
  const f = await fixture()
  try {
    const { sshPassword: _, ...base } = input
    const secrets = { sshPrivateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-key-secret\n-----END OPENSSH PRIVATE KEY-----', sshPrivateKeyPassphrase: 'key-passphrase-secret' }
    const response = await f.post({ ...base, ...secrets, os: 'windows', sshPort: 2222, wolPort: 65535 }, f.b.token)
    assert.equal(response.status, 201)
    const { computer } = await response.json()
    assert.equal(computer.os, 'windows')
    assert.equal(computer.sshPort, 2222)
    assert.equal(computer.wolPort, 65535)
    const saved = f.repo.findOwned(f.b.user.id, computer.id)!
    assert.deepEqual(decryptCredentials(f.config.credentialEncryptionKey, saved.id, saved.ownerId, saved.encryptedCredentials), secrets)
    const withoutPassphrase = await f.post({ ...base, sshPrivateKey: secrets.sshPrivateKey })
    assert.equal(withoutPassphrase.status, 201)
    f.statuses.set(computer.id, { status: 'online', checkedAt: '2026-10-14T10:00:00.000Z', sshStatus: 'unknown', sshCheckedAt: null })
    const own = await f.app.request('/computers', { headers: f.headers(f.b.token) })
    const body = await own.json()
    assert.equal(body.computers.length, 1)
    assert.equal(body.computers[0].id, computer.id)
    assert.equal(body.computers[0].status, 'online')
    assert.equal(body.computers[0].checkedAt, '2026-10-14T10:00:00.000Z')
    const other = await (await f.app.request('/computers', { headers: f.headers(f.a.token) })).json()
    assert.equal(other.computers.length, 1)
    assert.notEqual(other.computers[0].id, computer.id)
    assert.equal(f.repo.listAll().length, 2)
    const dbRows = JSON.stringify(f.db.prepare('SELECT * FROM computers').all())
    for (const secret of Object.values(secrets)) {
      assert.ok(!dbRows.includes(JSON.stringify(secret).slice(1,-1)))
      assert.ok(!JSON.stringify(body).includes(secret))
    }
    assert.ok(!JSON.stringify(body).includes('encryptedCredentials'))
    assert.ok(!JSON.stringify(body).includes('ownerId'))
    const decorated = { ...saved, sshPassword: 'unexpected-secret', futureSecret: 'future-secret' }
    assert.ok(!JSON.stringify(toPublicComputer(decorated, {status:'unknown', checkedAt:null,sshStatus:'unknown',sshCheckedAt:null})).includes('secret'))
  } finally { f.db.close() }
})

test('strict registration rejects invalid fields and credential combinations without saving or notifying', async () => {
  const f = await fixture()
  try {
    const { sshPassword: _, ...withoutPassword } = input
    const invalid: unknown[] = [null, [], 'bad', {}, { ...input, name:'' }, { ...input, name:' '.repeat(5) }, { ...input, name:'a'.repeat(101) }, { ...input, sshUsername:'' }, { ...input, sshUsername:'a'.repeat(129) }, { ...input, os:'macos' }, { ...input, os:null }, { ...input, ipAddress:'256.0.0.1' }, { ...input, ipAddress:'01.2.3.4' }, { ...input, ipAddress:'localhost' }, { ...input, ipAddress:'::1' }, { ...input, broadcastAddress:'999.1.1.1' }, { ...input, macAddress:'aa:bb:cc:dd:ee' }, { ...input, macAddress:'aa-bb:cc-dd-ee-ff' }, { ...input, sshPort:0 }, { ...input, sshPort:65536 }, { ...input, sshPort:1.5 }, { ...input, wolPort:'9' }, { ...input, sshPort:null }, { ...input, sshHostKeyFingerprint:'SHA256:abc' }, { ...input, sshHostKeyFingerprint:fingerprint+'=' }, { ...input, sshHostKeyFingerprint:'MD5:aa:bb' }, { ...input, sshHostKeyFingerprint:'SHA256:'+ 'A'.repeat(42)+'B' }, withoutPassword, { ...input, sshPrivateKey:'also-key' }, { ...input, sshPassword:'' }, { ...input, sshPassword:12 }, { ...input, sshPrivateKeyPassphrase:'unattached' }, { ...withoutPassword, sshPrivateKey:'' }, { ...withoutPassword, sshPrivateKey:'key', sshPrivateKeyPassphrase:null }, { ...input, sshPassword:'s'.repeat(32768) }, { ...input, sshPassword:'🔥'.repeat(10000) }, { ...withoutPassword, sshPrivateKey:'k'.repeat(20000), sshPrivateKeyPassphrase:'p'.repeat(20000) }, { ...input, sshPasswrod:'typo' }, { ...input, ownerId:f.b.user.id }, { ...input, id:'injected' }, { ...input, status:'online' }, { ...input, command:'shutdown' }, { ...input, createdAt:'injected' }]
    for (const body of invalid) {
      const response = await f.post(body)
      assert.equal(response.status, 400, JSON.stringify(body).slice(0,200))
      assert.deepEqual(await response.json(), { error:'Invalid computer input' })
    }
    assert.equal(f.repo.listAll().length, 0)
    assert.deepEqual(f.snapshots, [])
  } finally { f.db.close() }
})

test('computer routes require sessions, JSON, valid body and exact browser Origin', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.app.request('/computers')).status, 401)
    assert.equal((await f.post(input, '')).status, 401)
    const h = f.headers(f.a.token)
    assert.equal((await f.app.request('/computers', {method:'POST',headers:h,body:'{}'})).status, 415)
    assert.equal((await f.app.request('/computers', {method:'POST',headers:{...h,'content-type':'application/json'},body:'{'})).status, 400)
    assert.equal((await f.app.request('/computers', {headers:{...h,origin:'https://evil.example'}})).status, 403)
    assert.equal(f.repo.listAll().length, 0)
  } finally { f.db.close() }
})


test('default status works and failed snapshot delivery does not fail persisted registration', async () => {
  const f = await fixture()
  try {
    const app = createApp({ config:f.config, authService:f.auth, registerRoutes: app => app.route('/computers', computersRoutes({ repository:f.repo, config:f.config, authService:f.auth, onRegistered: () => { throw new Error('client disconnected') } })) })
    const response = await app.request('/computers', { method:'POST', headers:{...f.headers(f.a.token), 'content-type':'application/json'}, body:JSON.stringify({...input, name:'a'.repeat(100), sshUsername:'u'.repeat(128), sshPort:1, wolPort:1}) })
    assert.equal(response.status, 201)
    const {computer} = await response.json()
    const listing = await (await app.request('/computers', {headers:f.headers(f.a.token)})).json()
    assert.deepEqual(listing.computers, [computer])
    assert.equal(f.repo.listOwned(f.a.user.id).length, 1)
    assert.equal(f.repo.findOwned("' OR 1=1 --", computer.id), null)
    assert.equal(f.repo.findOwned(f.a.user.id, "' OR 1=1 --"), null)
  } finally { f.db.close() }
})

test('optional color is nullable, canonical and persisted in public lists', async () => {
  const f = await fixture()
  try {
    for (const [fields, expected] of [[{}, null], [{ color: null }, null], [{ color: '#Aa00Ff' }, '#aa00ff']] as const) {
      const response = await f.post({ ...input, ...fields })
      assert.equal(response.status, 201)
      const { computer } = await response.json()
      assert.equal(computer.color, expected)
      assert.equal(f.repo.findOwned(f.a.user.id, computer.id)!.color, expected)
      const list = await (await f.app.request('/computers', { headers: f.headers(f.a.token) })).json()
      assert.equal(list.computers.find((c: { id: string }) => c.id === computer.id).color, expected)
    }
    for (const color of ['', '#abc', '#12345678', '123456', '#gg0000', ' #123456', '#123456\n', 123, true, [], {}]) {
      assert.equal((await f.post({ ...input, color })).status, 400, JSON.stringify(color))
    }
    assert.equal(f.repo.listAll().length, 3)
  } finally { f.db.close() }
})

test('delete is authenticated, owner scoped, removes credentials and never runs power actions', async () => {
  const f = await fixture()
  try {
    const { computer } = await (await f.post(input)).json()
    const deleted: unknown[] = [], actions: string[] = []
    const app = createApp({ config: f.config, authService: f.auth, registerRoutes: app => app.route('/computers', computersRoutes({ repository: f.repo, authService: f.auth, config: f.config,
      power: { wake: async () => { actions.push('wake') }, shutdown: async () => { actions.push('shutdown') } },
      onDeleted: (owner, id) => { deleted.push([owner, id]) },
    })) })
    const remove = (id: string, token?: string) => app.request(`/computers/${id}`, { method: 'DELETE', headers: token ? f.headers(token) : {} })
    assert.equal((await remove(computer.id)).status, 401)
    const foreign = await remove(computer.id, f.b.token), missing = await remove('missing', f.a.token)
    assert.equal(foreign.status, 404); assert.equal(missing.status, 404)
    assert.deepEqual(await foreign.json(), await missing.json())
    assert.equal(f.repo.listAll().length, 1)
    assert.deepEqual(deleted, [])
    const response = await remove(computer.id, f.a.token)
    assert.equal(response.status, 204); assert.equal(await response.text(), '')
    assert.deepEqual(deleted, [[f.a.user.id, computer.id]])
    assert.deepEqual(f.repo.listAll(), [])
    assert.deepEqual(f.db.prepare('SELECT encrypted_credentials FROM computers').all(), [])
    assert.deepEqual((await (await f.app.request('/computers', { headers: f.headers(f.a.token) })).json()).computers, [])
    assert.equal((await remove(computer.id, f.a.token)).status, 404)
    assert.deepEqual(actions, [])
  } finally { f.db.close() }
})


test('legacy file migration reopens twice without changing identities or encrypted credentials', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lightning-migration-'))
  const path = join(directory, 'legacy.sqlite')
  const config = loadConfig({ FRONTEND_ORIGIN: 'https://app.example', CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 42).toString('base64') })
  let db = openDatabase(path)
  try {
    const users = new UserRepository(db)
    const owner = { id: 'legacy-owner', email: 'legacy@example.com', passwordHash: 'preserved-password-hash', createdAt: '2026-10-14T00:00:00.000Z' }
    users.create(owner)
    // Build the original schema, without color, and a ciphertext bound to fixed IDs.
    db.exec('DROP TABLE computers; CREATE TABLE computers (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, os TEXT NOT NULL, ip_address TEXT NOT NULL, mac_address TEXT NOT NULL, broadcast_address TEXT NOT NULL, ssh_port INTEGER NOT NULL, wol_port INTEGER NOT NULL, ssh_username TEXT NOT NULL, ssh_host_key_fingerprint TEXT NOT NULL, encrypted_credentials TEXT NOT NULL, created_at TEXT NOT NULL) STRICT')
    const ciphertext = encryptCredentials(config.credentialEncryptionKey, 'legacy-id', owner.id, { sshPassword: 'legacy-secret' })
    db.prepare('INSERT INTO computers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('legacy-id', owner.id, 'Legacy', 'linux', '192.168.1.20', 'aa:bb:cc:dd:ee:ff', '192.168.1.255', 22, 9, 'operator', fingerprint, ciphertext, '2026-10-14T00:00:00.000Z')
    const original = { ...db.prepare('SELECT * FROM computers').get()! }
    for (let attempt = 0; attempt < 2; attempt++) {
      db.close(); db = openDatabase(path)
      const migrated = { ...db.prepare('SELECT * FROM computers').get()! }
      assert.deepEqual(migrated, { ...original, color: null })
      const repo = new ComputerRepository(db, (id, uid, credentials) => encryptCredentials(config.credentialEncryptionKey, id, uid, credentials))
      const saved = repo.findOwned(owner.id, 'legacy-id')!
      assert.equal(saved.color, null)
      assert.equal(saved.encryptedCredentials, ciphertext)
      assert.deepEqual(decryptCredentials(config.credentialEncryptionKey, saved.id, saved.ownerId, saved.encryptedCredentials), { sshPassword: 'legacy-secret' })
      assert.equal(new UserRepository(db).findById(owner.id)!.passwordHash, 'preserved-password-hash')
    }
    const repo = new ComputerRepository(db, (id, uid, credentials) => encryptCredentials(config.credentialEncryptionKey, id, uid, credentials))
    const colored = repo.create(owner.id, parseComputerInput({ ...input, color: '#FeDcBa' }))
    db.close(); db = openDatabase(path)
    const reopened = new ComputerRepository(db, () => { throw new Error('must not re-encrypt') })
    assert.equal(reopened.findOwned(owner.id, colored.id)!.color, '#fedcba')
    assert.equal(reopened.findOwned(owner.id, colored.id)!.encryptedCredentials, colored.encryptedCredentials)
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }) }
})

// Owner lookup and empty-body validation must precede every diagnostic adapter call.
test('SSH check endpoint authenticates owners, returns safe diagnostics and rejects unavailable checks', async () => {
  const f = await fixture()
  try {
    const { computer } = await (await f.post(input)).json()
    let calls = 0
    const diagnostic = { status: 'online' as const, checkedAt: '2026-10-15T00:00:00.000Z', sshStatus: 'auth_failed' as const, sshCheckedAt: '2026-10-15T00:00:00.000Z' }
    const app = createApp({ config: f.config, authService: f.auth, registerRoutes: app => app.route('/computers', computersRoutes({ config: f.config, authService: f.auth, repository: f.repo,
      status: { get: () => diagnostic, checkSsh: async () => { calls++; return diagnostic } } as any,
    })) })
    const check = (id: string, token?: string, body?: string) => app.request(`/computers/${id}/check-ssh`, { method: 'POST', headers: token ? f.headers(token) : {}, body })
    assert.equal((await check(computer.id)).status, 401)
    assert.equal((await check(computer.id, f.b.token)).status, 404)
    assert.equal((await check('missing', f.a.token)).status, 404)
    assert.equal((await check(computer.id, f.a.token, '{}')).status, 400)
    assert.equal(calls, 0)
    const response = await check(computer.id, f.a.token)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { computerId: computer.id, ...diagnostic })
    assert.equal(calls, 1)
    assert.equal((await f.app.request(`/computers/${computer.id}/check-ssh`, { method: 'POST', headers: f.headers(f.a.token) })).status, 503)
    const listed = await (await app.request('/computers', { headers: f.headers(f.a.token) })).json()
    assert.equal(listed.computers[0].sshStatus, 'auth_failed')
    assert.equal(listed.computers[0].sshCheckedAt, '2026-10-15T00:00:00.000Z')
  } finally { f.db.close() }
})

test('deletion while reading a manual diagnostic body prevents admission and cache or events', async () => {
  const f = await fixture()
  const { StatusService } = await import('../src/services/status.service.js')
  let probes = 0, sshChecks = 0
  const changes: string[] = []
  const status = new StatusService(f.repo, async () => { probes++; return 'online' }, {
    checkSsh: async () => { sshChecks++; return { status: 'ready' } },
  })
  try {
    const { computer } = await (await f.post(input)).json()
    status.onChange(c => changes.push(c.id))
    const app = createApp({ config: f.config, authService: f.auth, registerRoutes: app => app.route('/computers', computersRoutes({ config: f.config, authService: f.auth, repository: f.repo, status,
      onDeleted: (_owner, id) => status.remove(id),
    })) })
    let body!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(controller) { body = controller } })
    let responded = false
    const pending = app.request(`/computers/${computer.id}/check-ssh`, {
      method: 'POST', headers: { ...f.headers(f.a.token), 'content-length': '0' }, body: stream, duplex: 'half',
    } as RequestInit).then(response => { responded = true; return response })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(responded, false)
    assert.equal((await app.request(`/computers/${computer.id}`, { method: 'DELETE', headers: f.headers(f.a.token) })).status, 204)
    body.close()
    assert.equal((await pending).status, 404)
    assert.equal(probes, 0)
    assert.equal(sshChecks, 0)
    assert.deepEqual(changes, [])
    assert.deepEqual(status.get(computer.id), { status: 'unknown', checkedAt: null, sshStatus: 'unknown', sshCheckedAt: null })
  } finally { await status.stop(); f.db.close() }
})

test('PATCH updates owned fields partially, preserves ciphertext even if corrupt, and returns only public data', async () => {
  const f = await fixture()
  try {
    const { computer } = await (await f.post({ ...input, color: '#abcdef' })).json()
    const patch = (body: unknown, token = f.a.token) => f.app.request(`/computers/${computer.id}`, { method: 'PATCH', headers: { ...f.headers(token), 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const original = f.repo.findOwned(f.a.user.id, computer.id)!
    const response = await patch({ name: 'Updated', color: null, os: 'windows', sshPort: 2222, wolPort: 8, macAddress: 'AA-BB-CC-DD-EE-00' })
    assert.equal(response.status, 200)
    const result = (await response.json()).computer
    assert.equal(result.name, 'Updated'); assert.equal(result.color, null); assert.equal(result.os, 'windows')
    assert.equal(result.macAddress, 'aa:bb:cc:dd:ee:00'); assert.equal(result.sshPort, 2222); assert.equal(result.wolPort, 8)
    assert.equal(result.ipAddress, input.ipAddress); assert.equal(result.createdAt, computer.createdAt)
    assert.equal(f.repo.findOwned(f.a.user.id, computer.id)!.encryptedCredentials, original.encryptedCredentials)
    assert.deepEqual(Object.keys(result).sort(), Object.keys(computer).sort())
    f.db.prepare('UPDATE computers SET encrypted_credentials = ? WHERE id = ?').run('corrupt', computer.id)
    assert.equal((await patch({ name: 'Still editable' })).status, 200)
    assert.equal(f.repo.findOwned(f.a.user.id, computer.id)!.encryptedCredentials, 'corrupt')
    assert.equal((await patch({ name: 'Forbidden' }, f.b.token)).status, 404)
  } finally { f.db.close() }
})

test('PATCH replaces credential modes, supports private-key passphrase edits, and strictly validates input', async () => {
  const f = await fixture()
  try {
    const { computer } = await (await f.post(input)).json()
    const patch = (body: unknown) => f.app.request(`/computers/${computer.id}`, { method: 'PATCH', headers: { ...f.headers(f.a.token), 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const credentials = () => { const row = f.repo.findOwned(f.a.user.id, computer.id)!; return decryptCredentials(f.config.credentialEncryptionKey, row.id, row.ownerId, row.encryptedCredentials) }
    assert.equal((await patch({ sshPrivateKeyPassphrase: 'password mode cannot use this' })).status, 400)
    assert.equal((await patch({ sshPrivateKey: 'key-one', sshPrivateKeyPassphrase: 'phrase' })).status, 200)
    assert.deepEqual(credentials(), { sshPrivateKey: 'key-one', sshPrivateKeyPassphrase: 'phrase' })
    assert.equal((await patch({ sshPrivateKeyPassphrase: 'new phrase' })).status, 200)
    assert.deepEqual(credentials(), { sshPrivateKey: 'key-one', sshPrivateKeyPassphrase: 'new phrase' })
    assert.equal((await patch({ sshPrivateKeyPassphrase: null })).status, 200)
    assert.deepEqual(credentials(), { sshPrivateKey: 'key-one' })
    assert.equal((await patch({ sshPrivateKeyPassphrase: 'phrase' })).status, 200)
    assert.equal((await patch({ sshPrivateKey: 'key-two' })).status, 200)
    assert.deepEqual(credentials(), { sshPrivateKey: 'key-two' })
    const replaced = await patch({ sshPassword: 'new-secret' })
    assert.equal(replaced.status, 200); assert.equal((await replaced.text()).includes('new-secret'), false)
    assert.deepEqual(credentials(), { sshPassword: 'new-secret' })
    const before = f.repo.findOwned(f.a.user.id, computer.id)!
    for (const body of [null, [], '', {}, { id: 'other' }, { ownerId: 'other' }, { createdAt: 'today' }, { status: 'online' }, { encryptedCredentials: 'x' }, { unknown: 1 }, { name: null }, { os: null }, { ipAddress: null }, { macAddress: null }, { broadcastAddress: null }, { sshUsername: null }, { sshPort: null }, { wolPort: 0 }, { color: 'red' }, { sshHostKeyFingerprint: null }, { sshPassword: null }, { sshPrivateKey: null }, { sshPassword: 'x', sshPrivateKey: 'y' }, { sshPassword: 'x', sshPrivateKeyPassphrase: null }, { sshPrivateKey: 'x', sshPrivateKeyPassphrase: 5 }, { sshPrivateKey: 'x', sshPrivateKeyPassphrase: 'a'.repeat(32768) }, { sshPassword: '😀'.repeat(10000) }]) {
      assert.equal((await patch(body)).status, 400, JSON.stringify(body).slice(0, 100))
    }
    assert.deepEqual(f.repo.findOwned(f.a.user.id, computer.id), before)
    assert.equal((await f.app.request(`/computers/${computer.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401)
    assert.equal((await f.app.request('/computers/missing', { method: 'PATCH', headers: { ...f.headers(f.a.token), 'content-type': 'application/json' }, body: '{"name":"New"}' })).status, 404)
    assert.equal((await f.app.request(`/computers/${computer.id}`, { method: 'PATCH', headers: f.headers(f.a.token), body: '{}' })).status, 415)
    assert.equal((await f.app.request(`/computers/${computer.id}`, { method: 'PATCH', headers: { ...f.headers(f.a.token), 'content-type': 'application/json' }, body: '{' })).status, 400)
  } finally { f.db.close() }
})

test('PATCH reads the latest row after body streaming and cannot recreate a deleted computer', async () => {
  const f = await fixture()
  try {
    const { computer } = await (await f.post(input)).json()
    const deferred = () => {
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
      const response = f.app.request(`/computers/${computer.id}`, { method: 'PATCH', headers: { ...f.headers(f.a.token), 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit)
      return { response, finish() { controller.enqueue(new TextEncoder().encode('{"name":"Slow edit"}')); controller.close() } }
    }
    const first = deferred(); await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal((await f.app.request(`/computers/${computer.id}`, { method: 'PATCH', headers: { ...f.headers(f.a.token), 'content-type': 'application/json' }, body: '{"sshPort":2223}' })).status, 200)
    first.finish(); assert.equal((await first.response).status, 200)
    assert.equal(f.repo.findOwned(f.a.user.id, computer.id)!.sshPort, 2223)
    const second = deferred(); await new Promise<void>(resolve => setImmediate(resolve))
    f.repo.deleteOwned(f.a.user.id, computer.id)
    second.finish(); assert.equal((await second.response).status, 404)
    assert.equal(f.repo.listAll().length, 0)
  } finally { f.db.close() }
})
