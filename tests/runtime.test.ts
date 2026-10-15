import { test } from 'node:test'
import { createLogger } from '../src/logging.js'
import assert from 'node:assert/strict'
import { IncomingMessage } from 'node:http'
import { Duplex } from 'node:stream'
import { WebSocket } from 'ws'
import { loadConfig } from '../src/config.js'
import { createRuntime } from '../src/index.js'

class Wire extends Duplex {
  peer?: Wire
  _read() {}
  _write(chunk: Buffer, _encoding: string, done: () => void) {
    if (!chunk.toString().startsWith('HTTP/1.1')) this.peer?.push(Buffer.from(chunk))
    done()
  }
  _destroy(error: Error | null, done: (error: Error | null) => void) {
    if (this.peer && !this.peer.destroyed) this.peer.destroy()
    done(error)
  }
}
const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)); await new Promise<void>(resolve => setImmediate(resolve)) }

test('runtime composes real auth/storage/routes/owner WebSockets and closes without listening', async () => {
  const config = loadConfig({ NODE_ENV: 'development', DATABASE_PATH: ':memory:', CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') })
  const actions: string[] = []
  const logs:string[]=[]
  let deferProbe = false
  let releaseProbe: (() => void) | undefined
  let sshStatus: 'ready' | 'auth_failed' = 'ready'
  const runtime = createRuntime(config, { checkSsh: async () => ({ status: sshStatus }), logger:createLogger(line=>logs.push(line)), power: { wake: async c => { actions.push(c.id) }, shutdown: async c => { actions.push(c.id) } }, probe: async () => { if (deferProbe) { await new Promise<void>(resolve => { releaseProbe = resolve }); return 'offline' }; return 'online' } })
  const clients: WebSocket[] = []
  try {
    const request = (path: string, cookie = '', body?: unknown) => runtime.app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json', origin: config.frontendOrigin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const register = async (email: string) => {
      const response = await request('/auth/register', '', { email, password: 'long integration password' })
      assert.equal(response.status, 201)
      return response.headers.get('set-cookie')!.split(';')[0]!
    }
    const owner = await register('owner@example.com'), other = await register('other@example.com')
    const connect = async (cookie: string) => {
      const outgoing = new Wire(), incoming = new Wire(); outgoing.peer = incoming; incoming.peer = outgoing
      const client = new WebSocket(null as never, undefined, { closeTimeout: 10 } as never)
      ;(client as any)._isServer = false
      const messages: any[] = []
      client.on('message', data => messages.push(JSON.parse(data.toString())))
      client.on('error', () => {})
      ;(client as any).setSocket(incoming, Buffer.alloc(0), { allowSynchronousEvents: true, maxPayload: 1024 * 1024, skipUTF8Validation: false })
      clients.push(client)
      const req = new IncomingMessage(outgoing as any)
      req.method = 'GET'; req.url = '/ws/computers'
      req.headers = { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': Buffer.alloc(16, 3).toString('base64'), origin: config.frontendOrigin, cookie }
      runtime.server.emit('upgrade', req, outgoing, Buffer.alloc(0))
      await flush()
      return { client, messages }
    }
    const a = await connect(owner), b = await connect(other)
    assert.deepEqual(a.messages[0], { type: 'snapshot', computers: [] })
    const created = await request('/computers', owner, { name: 'Office', color: '#Aa11Ff', ipAddress: '192.168.1.2', macAddress: 'aa:bb:cc:dd:ee:ff', broadcastAddress: '192.168.1.255', sshUsername: 'operator', sshHostKeyFingerprint: `SHA256:${Buffer.alloc(32, 7).toString('base64').replace(/=+$/, '')}`, sshPassword: 'test-credential' })
    assert.equal(created.status, 201)
    const { computer } = await created.json()
    await flush()
    assert.equal(a.messages[1].computers[0].id, computer.id)
    assert.equal(a.messages[1].computers[0].color, '#aa11ff')
    assert.equal(b.messages.length, 1)
    await runtime.statusService.pollOnce(); await flush()
    assert.equal(a.messages[2].status, 'online')
    assert.equal(a.messages[2].sshStatus, 'ready')
    const listed = await (await request('/computers', owner)).json()
    assert.equal(listed.computers[0].status, 'online')
    assert.deepEqual((await (await request('/computers', other)).json()).computers, [])
    assert.equal((await request(`/computers/${computer.id}/on`, other, {})).status, 404)
    assert.equal((await request(`/computers/${computer.id}/on`, owner, {})).status, 202)
    assert.deepEqual(actions, [computer.id])
    const row = runtime.database.prepare('SELECT encrypted_credentials FROM computers').get()!
    assert.equal(String(row.encrypted_credentials).includes('test-credential'), false)
    assert.equal(JSON.stringify([...a.messages, listed]).includes('encryptedCredentials'), false)
    sshStatus = 'auth_failed'
    const checked = await runtime.app.request(`/computers/${computer.id}/check-ssh`, { method: 'POST', headers: { cookie: owner } })
    assert.equal(checked.status, 200)
    assert.equal((await checked.json()).sshStatus, 'auth_failed')
    await flush()
    assert.equal(a.messages[3].type, 'status')
    assert.equal(a.messages[3].status, 'online')
    assert.equal(a.messages[3].sshStatus, 'auth_failed')
    assert.equal(b.messages.length, 1)
    const beforeEditCount = a.messages.length
    const edited = await runtime.app.request(`/computers/${computer.id}`, { method: 'PATCH', headers: { cookie: owner, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Edited Office', sshPassword: 'replacement-secret' }) })
    assert.equal(edited.status, 200)
    assert.equal((await edited.json()).computer.sshStatus, 'unknown')
    await flush()
    assert.equal(a.messages.length, beforeEditCount + 1)
    assert.equal(a.messages.at(-1).type, 'snapshot')
    assert.equal(a.messages.at(-1).computers[0].name, 'Edited Office')
    assert.equal(a.messages.at(-1).computers[0].sshStatus, 'unknown')
    assert.equal(JSON.stringify(a.messages).includes('replacement-secret'), false)
    assert.equal(b.messages.length, 1)
    deferProbe = true
    const pendingRound = runtime.statusService.pollOnce(); await flush()
    const removed = await runtime.app.request(`/computers/${computer.id}`, { method: 'DELETE', headers: { cookie: owner } })
    releaseProbe!(); await pendingRound; await flush()
    assert.equal(removed.status, 204)
    assert.equal(await removed.text(), '')
    assert.deepEqual(a.messages.slice(beforeEditCount + 1), [{ type: 'snapshot', computers: [] }])
    assert.equal(b.messages.length, 1)
    assert.deepEqual(runtime.statusService.get(computer.id), { status: 'unknown', checkedAt: null, sshStatus: 'unknown', sshCheckedAt: null })
    assert.deepEqual((await (await request('/computers', owner)).json()).computers, [])
    assert.equal(runtime.database.prepare('SELECT * FROM computers').get(), undefined)
    assert.deepEqual(actions, [computer.id])
    assert.equal((await request('/auth/logout', owner, {})).status, 204); await flush()
    assert.equal(a.client.readyState, WebSocket.CLOSED)
    assert.equal((await request(`/computers/${computer.id}/off`, owner, {})).status, 401)
    await runtime.stop(); await runtime.stop(); await flush()
    assert.equal(b.client.readyState, WebSocket.CLOSED)
    assert.equal(runtime.server.listenerCount('upgrade'), 0)
    assert.throws(() => runtime.database.prepare('SELECT 1'))
    const events=logs.map(line=>JSON.parse(line).event)
    assert.equal(events.filter(event=>event==='shutdown_started').length,1)
    assert.equal(events.filter(event=>event==='shutdown_complete').length,1)
    assert.ok(events.every(event=>['http_request','power_action','ssh_check','shutdown_started','shutdown_complete'].includes(event)))
    for(const secret of ['owner@example.com','test-credential','long integration password',owner]) assert.equal(logs.join('').includes(secret),false)
  } finally { releaseProbe?.(); clients.forEach(client => client.terminate()); await runtime.stop() }
})

// A deleted record must not reappear when its admitted real diagnostic completes.
test('manual diagnostic deletion suppresses cache and returns 404; runtime stop awaits active SSH', async () => {
  const config = loadConfig({ NODE_ENV: 'development', DATABASE_PATH: ':memory:', CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') })
  let release: (() => void) | undefined, checks = 0
  const lines: string[] = []
  const runtime = createRuntime(config, { logger: createLogger(line => lines.push(line)), probe: async () => 'online',
    checkSsh: async () => { checks++; await new Promise<void>(resolve => { release = resolve }); return { status: 'ready' } },
  })
  try {
    const registered = await runtime.app.request('/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'diagnostic@example.com', password: 'long integration password' }) })
    const cookie = registered.headers.get('set-cookie')!.split(';')[0]!
    const create = await runtime.app.request('/computers', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Office', ipAddress: '192.168.1.2', macAddress: 'aa:bb:cc:dd:ee:ff', broadcastAddress: '192.168.1.255', sshUsername: 'operator', sshHostKeyFingerprint: `SHA256:${Buffer.alloc(32, 7).toString('base64').replace(/=+$/, '')}`, sshPassword: 'test-credential' }) })
    const { computer } = await create.json()
    const check = () => runtime.app.request(`/computers/${computer.id}/check-ssh`, { method: 'POST', headers: { cookie } })
    const pending = check(), same = check()
    await flush(); assert.equal(checks, 1)
    assert.equal((await runtime.app.request(`/computers/${computer.id}`, { method: 'DELETE', headers: { cookie } })).status, 204)
    let stopped = false
    const stopping = runtime.stop().then(() => { stopped = true })
    await flush(); assert.equal(stopped, false)
    release!()
    const responses = await Promise.all([pending, same])
    assert.deepEqual(responses.map(r => r.status), [404, 404])
    assert.deepEqual(await responses[0]!.json(), { error: 'Not found' })
    await stopping
    assert.equal(runtime.statusService.get(computer.id).sshStatus, 'unknown')
    assert.equal(lines.map(line => JSON.parse(line)).filter(e => e.event === 'ssh_check').length, 0)
  } finally { release?.(); await runtime.stop() }
})

test('editing during an HTTP SSH check returns unavailable and cannot publish the old credential result', async () => {
  const config = loadConfig({ NODE_ENV: 'development', DATABASE_PATH: ':memory:', CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') })
  let release!: () => void, defer = true
  const runtime = createRuntime(config, { logger: createLogger(() => {}), probe: async () => 'online',
    checkSsh: async () => { if (defer) await new Promise<void>(resolve => { release = resolve }); return { status: 'ready' } },
  })
  try {
    const registration = await runtime.app.request('/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'edit@example.com', password: 'long integration password' }) })
    const cookie = registration.headers.get('set-cookie')!.split(';')[0]!
    const headers = { cookie, 'content-type': 'application/json' }
    const created = await runtime.app.request('/computers', { method: 'POST', headers, body: JSON.stringify({ name: 'Office', ipAddress: '192.168.1.2', macAddress: 'aa:bb:cc:dd:ee:ff', broadcastAddress: '192.168.1.255', sshUsername: 'operator', sshHostKeyFingerprint: `SHA256:${Buffer.alloc(32, 7).toString('base64').replace(/=+$/, '')}`, sshPassword: 'old-secret' }) })
    const { computer } = await created.json()
    const check = () => runtime.app.request(`/computers/${computer.id}/check-ssh`, { method: 'POST', headers: { cookie } })
    const pending = check(); await flush()
    const edited = await runtime.app.request(`/computers/${computer.id}`, { method: 'PATCH', headers, body: '{"sshPassword":"replacement-secret"}' })
    assert.equal(edited.status, 200)
    assert.equal((await edited.json()).computer.sshStatus, 'unknown')
    assert.equal((await check()).status, 503)
    release(); assert.equal((await pending).status, 503)
    assert.equal(runtime.statusService.get(computer.id).sshStatus, 'unknown')
    defer = false
    assert.equal((await check()).status, 200)
    assert.equal(runtime.statusService.get(computer.id).sshStatus, 'ready')
  } finally { release?.(); await runtime.stop() }
})
