import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase } from '../src/database.js'
import { loadConfig } from '../src/config.js'
import { UserRepository } from '../src/repositories/user.repository.js'
import { SessionRepository } from '../src/repositories/session.repository.js'
import { AuthService } from '../src/services/auth.service.js'
import { encryptCredentials, decryptCredentials } from '../src/services/credentials.service.js'
import { ComputerRepository, toPublicComputer } from '../src/repositories/computer.repository.js'
import { computersRoutes } from '../src/routes/computers.js'
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
  const statuses = new Map<string, {status: 'online'; checkedAt: string}>()
  const app = createApp({ config, authService: auth, registerRoutes: app => app.route('/computers', computersRoutes({ repository: repo, authService: auth, config, status: { get: id => statuses.get(id) ?? { status: 'unknown', checkedAt: null } }, onRegistered: owner => { snapshots.push(owner) } })) })
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
    assert.deepEqual(Object.keys(computer).sort(), ['id','name','os','ipAddress','macAddress','broadcastAddress','sshPort','wolPort','sshUsername','sshHostKeyFingerprint','createdAt','status','checkedAt'].sort())
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
    f.statuses.set(computer.id, { status: 'online', checkedAt: '2026-10-14T10:00:00.000Z' })
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
    assert.ok(!JSON.stringify(toPublicComputer(decorated, {status:'unknown', checkedAt:null})).includes('secret'))
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
