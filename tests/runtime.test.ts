import { test } from 'node:test'
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
  const runtime = createRuntime(config, { power: { wake: async c => { actions.push(c.id) }, shutdown: async c => { actions.push(c.id) } }, probe: async () => 'online' })
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
    const created = await request('/computers', owner, { name: 'Office', ipAddress: '192.168.1.2', macAddress: 'aa:bb:cc:dd:ee:ff', broadcastAddress: '192.168.1.255', sshUsername: 'operator', sshHostKeyFingerprint: `SHA256:${Buffer.alloc(32, 7).toString('base64').replace(/=+$/, '')}`, sshPassword: 'test-credential' })
    assert.equal(created.status, 201)
    const { computer } = await created.json()
    await flush()
    assert.equal(a.messages[1].computers[0].id, computer.id)
    assert.equal(b.messages.length, 1)
    await runtime.statusService.pollOnce(); await flush()
    assert.equal(a.messages[2].status, 'online')
    const listed = await (await request('/computers', owner)).json()
    assert.equal(listed.computers[0].status, 'online')
    assert.deepEqual((await (await request('/computers', other)).json()).computers, [])
    assert.equal((await request(`/computers/${computer.id}/on`, other, {})).status, 404)
    assert.equal((await request(`/computers/${computer.id}/on`, owner, {})).status, 202)
    assert.deepEqual(actions, [computer.id])
    const row = runtime.database.prepare('SELECT encrypted_credentials FROM computers').get()!
    assert.equal(String(row.encrypted_credentials).includes('test-credential'), false)
    assert.equal(JSON.stringify([...a.messages, listed]).includes('encryptedCredentials'), false)
    assert.equal((await request('/auth/logout', owner, {})).status, 204); await flush()
    assert.equal(a.client.readyState, WebSocket.CLOSED)
    assert.equal((await request(`/computers/${computer.id}/off`, owner, {})).status, 401)
    await runtime.stop(); await runtime.stop(); await flush()
    assert.equal(b.client.readyState, WebSocket.CLOSED)
    assert.equal(runtime.server.listenerCount('upgrade'), 0)
    assert.throws(() => runtime.database.prepare('SELECT 1'))
  } finally { clients.forEach(client => client.terminate()); await runtime.stop() }
})
