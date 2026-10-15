import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import type { Computer, Status } from '../src/types.js'
import { StatusService, tcpProbe } from '../src/services/status.service.js'

const computer = (id: string): Computer => ({ id, ownerId:'owner', color:null, name:id, os:'linux', ipAddress:'192.168.1.2', macAddress:'aa:bb:cc:dd:ee:ff', broadcastAddress:'192.168.1.255', sshPort:2222, wolPort:9, sshUsername:'operator', sshHostKeyFingerprint:'fingerprint', encryptedCredentials:'encrypted', createdAt:'2026-10-14T00:00:00.000Z' })
const flush = async () => { for (let i=0; i<20; i++) await Promise.resolve() }

test('status starts unknown; timestamps refresh but only status transitions notify; errors become unknown', async () => {
  let now = Date.parse('2026-10-14T00:00:00.000Z')
  let result: Status | Error = 'online'
  const service = new StatusService({listAll:()=>[computer('one')]}, async () => { if (result instanceof Error) throw result; return result }, {now:()=>now})
  assert.deepEqual(service.get('one'), {status:'unknown',checkedAt:null,sshStatus:'unknown',sshCheckedAt:null})
  const changes: unknown[] = []
  service.onChange(()=>{throw new Error('bad subscriber')})
  const unsubscribe = service.onChange((c,s)=>changes.push([c.id,s]))
  await service.pollOnce()
  assert.deepEqual(service.get('one'), {status:'online',checkedAt:'2026-10-14T00:00:00.000Z',sshStatus:'unknown',sshCheckedAt:null})
  now += 10000
  await service.pollOnce()
  assert.equal(service.get('one').checkedAt,'2026-10-14T00:00:10.000Z')
  assert.equal(changes.length,1)
  result='offline'; await service.pollOnce()
  result=new Error('internal'); await service.pollOnce()
  assert.equal(service.get('one').status,'unknown')
  assert.equal(changes.length,3)
  unsubscribe(); result='online'; await service.pollOnce()
  assert.equal(changes.length,3)
  const exposed=service.get('one'); exposed.status='offline'
  assert.equal(service.get('one').status,'online')
  await service.stop()
})

test('ten workers cap probes; overlapping manual rounds share completion', async () => {
  let active=0, peak=0, calls=0
  const releases: (()=>void)[]=[]
  const service = new StatusService({listAll:()=>Array.from({length:23},(_,i)=>computer(String(i)))}, async () => {
    calls++; active++; peak=Math.max(peak,active)
    await new Promise<void>(resolve=>releases.push(resolve)); active--; return 'online'
  })
  const first=service.pollOnce(), second=service.pollOnce()
  await flush(); assert.equal(active,10); assert.equal(calls,10)
  while (releases.length) { releases.shift()!(); await flush() }
  await Promise.all([first,second])
  assert.equal(calls,23); assert.equal(peak,10)
  await service.stop()
})

test('start polls immediately every ten seconds without overlap; stop awaits round and restart is safe', async t => {
  t.mock.timers.enable({apis:['setInterval']})
  let calls=0, release: (()=>void)|undefined
  const service = new StatusService({listAll:()=>[computer('one')]}, async()=>{calls++; await new Promise<void>(resolve=>{release=resolve}); return 'online'})
  service.start(); service.start(); await flush(); assert.equal(calls,1)
  t.mock.timers.tick(30000); await flush(); assert.equal(calls,1)
  let stopped=false; const stopping=service.stop().then(()=>{stopped=true})
  await flush(); assert.equal(stopped,false)
  release!(); await stopping
  t.mock.timers.tick(20000); await flush(); assert.equal(calls,1)
  service.start(); await flush(); assert.equal(calls,2)
  release!(); await service.stop()
})

class ProbeSocket extends EventEmitter {
  timeout=0; destroyed=false; connection:unknown
  setTimeout(ms:number) { this.timeout=ms; return this }
  connect(options:unknown) { this.connection=options; return this }
  destroy() { this.destroyed=true; return this }
}
test('TCP probe connects SSH port, uses two-second deadline, and cleans all completion paths', async () => {
  for (const [event,error,want] of [
    ['connect',undefined,'online'], ['timeout',undefined,'offline'], ['close',undefined,'offline'],
    ['error',Object.assign(new Error('refused'),{code:'ECONNREFUSED'}),'offline'],
    ['error',Object.assign(new Error('timeout'),{code:'ETIMEDOUT'}),'offline'],
    ['error',new Error('internal'),'unknown'],
  ] as const) {
    const socket=new ProbeSocket()
    const result=tcpProbe(computer('one'),()=>socket as unknown as Socket)
    assert.deepEqual(socket.connection,{host:'192.168.1.2',port:2222})
    assert.equal(socket.timeout,2000)
    socket.emit(event,error)
    assert.equal(await result,want)
    assert.equal(socket.destroyed,true)
    assert.equal(socket.timeout,0)
    assert.equal(socket.eventNames().length,0)
  }
  assert.equal(await tcpProbe(computer('one'),()=>{throw new Error('factory failed')}),'unknown')
})

test('remove clears cached status and suppresses in-flight and queued results for the round', async () => {
  let rows = Array.from({ length: 11 }, (_, i) => computer(String(i)))
  let deferred = false
  const releases: (() => void)[] = [], probes: string[] = [], changes: string[] = []
  const service = new StatusService({ listAll: () => rows }, async c => {
    probes.push(c.id)
    if (deferred) await new Promise<void>(resolve => releases.push(resolve))
    return 'online'
  })
  service.onChange(c => changes.push(c.id))
  await service.pollOnce()
  assert.equal(service.get('0').status, 'online')
  deferred = true; changes.length = 0; probes.length = 0
  const round = service.pollOnce(); await flush()
  service.remove('0'); service.remove('10')
  rows = rows.filter(c => c.id !== '0' && c.id !== '10')
  assert.deepEqual(service.get('0'), { status: 'unknown', checkedAt: null, sshStatus: 'unknown', sshCheckedAt: null })
  while (releases.length) { releases.shift()!(); await flush() }
  await round
  assert.equal(probes.includes('10'), false)
  assert.equal(changes.includes('0'), false)
  assert.deepEqual(service.get('0'), { status: 'unknown', checkedAt: null, sshStatus: 'unknown', sshCheckedAt: null })
  // Suppression lasts only for the captured round, with no permanent tombstones.
  rows = [computer('0')]; deferred = false
  await service.pollOnce()
  assert.equal(service.get('0').status, 'online')
  assert.deepEqual(changes, ['0'])
})

// A stale ready result, missing cooldown, or forgotten lockout must fail these clock-driven tests.
test('SSH cadence is sixty seconds, TCP invalidates readiness and full-attempt timestamps survive disconnects', async () => {
  let now = 0, tcp: Status = 'online', calls = 0
  const service = new StatusService({ listAll: () => [computer('one')] }, async () => tcp, { now: () => now,
    checkSsh: async () => { calls++; return { status: 'ready' } },
  } as any)
  assert.deepEqual(service.get('one'), { status: 'unknown', checkedAt: null, sshStatus: 'unknown', sshCheckedAt: null })
  await service.pollOnce()
  assert.equal(service.get('one').sshStatus, 'ready'); assert.equal(calls, 1)
  now = 10000; await service.pollOnce(); assert.equal(calls, 1)
  tcp = 'offline'; now = 20000; await service.pollOnce()
  assert.equal(service.get('one').sshStatus, 'unreachable')
  assert.equal(service.get('one').sshCheckedAt, '1970-01-01T00:00:00.000Z')
  tcp = 'online'; now = 30000; await service.pollOnce()
  assert.equal(service.get('one').sshStatus, 'unknown'); assert.equal(calls, 1)
  now = 59999; await service.pollOnce(); assert.equal(calls, 1)
  now = 60000; await service.pollOnce(); assert.equal(calls, 2)
  assert.equal(service.get('one').sshStatus, 'ready')
  await service.stop()
})

for (const result of [{ status: 'auth_failed' }, { status: 'host_key_mismatch' }, { status: 'error', retryBlocked: true }]) test('automatic SSH latch survives offline/online until explicit retry: ' + result.status, async () => {
  let now = 0, tcp: Status = 'online', calls = 0
  const service = new StatusService({ listAll: () => [computer('one')] }, async () => tcp, { now: () => now,
    checkSsh: async () => { calls++; return calls === 1 ? result : { status: 'ready' } },
  } as any)
  await service.pollOnce(); assert.equal(calls, 1)
  tcp = 'offline'; now += 70000; await service.pollOnce()
  tcp = 'online'; now += 70000; await service.pollOnce(); assert.equal(calls, 1)
  assert.equal(typeof (service as any).checkSsh, 'function')
  await (service as any).checkSsh(computer('one')); assert.equal(calls, 2)
  assert.equal(service.get('one').sshStatus, 'ready')
  now += 60000; await service.pollOnce(); assert.equal(calls, 3)
  await service.stop()
})

test('manual checks coalesce with background, global capacity is ten, deletion suppresses results, stop awaits and blocks work', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => computer(String(i)))
  const releases: (() => void)[] = []; let calls = 0, probes = 0
  const changes: string[] = []
  const service = new StatusService({ listAll: () => rows }, async () => { probes++; return 'online' }, {
    checkSsh: async () => { calls++; await new Promise<void>(resolve => releases.push(resolve)); return { status: 'ready' } },
  } as any)
  assert.equal(typeof (service as any).checkSsh, 'function')
  service.onChange(c => changes.push(c.id))
  const pending = (service as any).checkSsh(rows[0])
  const same = (service as any).checkSsh(rows[0])
  const round = service.pollOnce(); await flush()
  assert.equal(calls, 10); assert.equal(probes, 10)
  await assert.rejects((service as any).checkSsh(rows[11]), { status: 429 })
  service.remove('0'); changes.length = 0
  const deleted = assert.rejects(pending, { status: 404 })
  const deletedSame = assert.rejects(same, { status: 404 })
  let stopped = false; const stopping = service.stop().then(() => { stopped = true })
  await flush(); assert.equal(stopped, false)
  while (releases.length) { releases.shift()!(); await flush() }
  await Promise.all([deleted, deletedSame, round, stopping])
  assert.equal(calls, 10); assert.equal(changes.includes('0'), false)
  assert.equal(service.get('0').sshStatus, 'unknown')
  await assert.rejects((service as any).checkSsh(rows[1]), { status: 503 })
  await service.pollOnce(); assert.equal(calls, 10)
})

test('manual TCP offline skips authentication and missing checker fails safely', async () => {
  let calls = 0
  const service = new StatusService({ listAll: () => [] }, async () => 'offline', { checkSsh: async () => { calls++; return { status: 'ready' } } } as any)
  assert.equal(typeof (service as any).checkSsh, 'function')
  assert.equal((await (service as any).checkSsh(computer('one'))).sshStatus, 'unreachable')
  assert.equal(calls, 0); assert.equal(service.get('one').sshCheckedAt, null)
  await service.stop()
  const unavailable = new StatusService({ listAll: () => [] }, async () => 'online')
  await assert.rejects((unavailable as any).checkSsh(computer('one')), { status: 503 })
  await unavailable.stop()
})

test('manual request joining a cooldown TCP probe upgrades the shared operation to full authentication', async () => {
  let calls = 0, release: (() => void) | undefined, defer = false
  const service = new StatusService({ listAll: () => [computer('one')] }, async () => {
    if (defer) await new Promise<void>(resolve => { release = resolve })
    return 'online'
  }, { now: () => 0, checkSsh: async () => { calls++; return { status: 'ready' } } } as any)
  await service.pollOnce(); assert.equal(calls, 1)
  defer = true
  const round = service.pollOnce(); await flush()
  const manual = service.checkSsh(computer('one'))
  release!(); await Promise.all([round, manual])
  assert.equal(calls, 2)
  await service.stop()
})

test('stop during manual TCP probe refuses to return a cached ready result without authentication', async () => {
  let defer = false, release: (() => void) | undefined, calls = 0
  const service = new StatusService({ listAll: () => [] }, async () => {
    if (defer) await new Promise<void>(resolve => { release = resolve })
    return 'online'
  }, { checkSsh: async () => { calls++; return { status: 'ready' } } })
  await service.checkSsh(computer('one')); assert.equal(calls, 1)
  defer = true
  const pending = service.checkSsh(computer('one'))
  await flush()
  const rejected = assert.rejects(pending, { status: 503 })
  const stopping = service.stop()
  release!(); await Promise.all([rejected, stopping])
  assert.equal(calls, 1)
})

test('edits invalidate active checks without freeing capacity, skip queued stale rows, then retry with current credentials', async () => {
  let rows = Array.from({ length: 11 }, (_, i) => computer(String(i)))
  const releases: (() => void)[] = [], checked: Computer[] = [], changes: string[] = []
  let defer = true
  const service = new StatusService({ listAll: () => rows }, async c => {
    checked.push(c)
    if (defer) await new Promise<void>(resolve => releases.push(resolve))
    return 'online'
  }, { checkSsh: async c => ({ status: c.encryptedCredentials === 'updated' ? 'ready' : 'auth_failed' }) })
  service.onChange(c => changes.push(c.id))
  try {
    const round = service.pollOnce(); await flush()
    rows = rows.map(c => ['0', '10'].includes(c.id) ? { ...c, ipAddress: '192.168.1.99', encryptedCredentials: 'updated' } : c)
    service.update('0'); service.update('10')
    await assert.rejects(service.checkSsh(rows[0]!), { status: 503 })
    await assert.rejects(service.checkSsh(computer('extra')), { status: 429 })
    while (releases.length) { releases.shift()!(); await flush() }
    await round
    assert.equal(checked.some(c => c.id === '10'), false)
    assert.equal(changes.includes('0'), false)
    assert.deepEqual(service.get('0'), { status: 'unknown', checkedAt: null, sshStatus: 'unknown', sshCheckedAt: null })
    defer = false; await service.pollOnce()
    assert.equal(checked.filter(c => c.id === '0').at(-1)!.ipAddress, '192.168.1.99')
    assert.equal(service.get('0').sshStatus, 'ready'); assert.equal(service.get('10').sshStatus, 'ready')
    // An update also clears an authentication latch and the sixty-second cooldown.
    rows = rows.map(c => c.id === '1' ? { ...c, encryptedCredentials: 'updated' } : c)
    service.update('1'); await service.pollOnce()
    assert.equal(service.get('1').sshStatus, 'ready')
  } finally { releases.forEach(release => release()); await service.stop() }
})

test('edits during full SSH authentication discard the old credential result', async () => {
  let row = computer('one'), release!: () => void
  const changes: string[] = []
  const service = new StatusService({ listAll: () => [row] }, async () => 'online', {
    checkSsh: async c => { if (c.encryptedCredentials === 'encrypted') await new Promise<void>(resolve => { release = resolve }); return { status: 'ready' } },
  })
  service.onChange(c => changes.push(c.id))
  try {
    const pending = service.checkSsh(row); await flush()
    row = { ...row, encryptedCredentials: 'new' }; service.update(row.id)
    const rejected = assert.rejects(pending, { status: 503 })
    release(); await rejected
    assert.deepEqual(changes, []); assert.equal(service.get(row.id).sshStatus, 'unknown')
    await service.pollOnce(); assert.equal(service.get(row.id).sshStatus, 'ready')
  } finally { release?.(); await service.stop() }
})
