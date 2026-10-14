import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import type { Computer, Status } from '../src/types.js'
import { StatusService, tcpProbe } from '../src/services/status.service.js'

const computer = (id: string): Computer => ({ id, ownerId:'owner', name:id, os:'linux', ipAddress:'192.168.1.2', macAddress:'aa:bb:cc:dd:ee:ff', broadcastAddress:'192.168.1.255', sshPort:2222, wolPort:9, sshUsername:'operator', sshHostKeyFingerprint:'fingerprint', encryptedCredentials:'encrypted', createdAt:'2026-10-14T00:00:00.000Z' })
const flush = async () => { for (let i=0; i<20; i++) await Promise.resolve() }

test('status starts unknown; timestamps refresh but only status transitions notify; errors become unknown', async () => {
  let now = Date.parse('2026-10-14T00:00:00.000Z')
  let result: Status | Error = 'online'
  const service = new StatusService({listAll:()=>[computer('one')]}, async () => { if (result instanceof Error) throw result; return result }, {now:()=>now})
  assert.deepEqual(service.get('one'), {status:'unknown',checkedAt:null})
  const changes: unknown[] = []
  service.onChange(()=>{throw new Error('bad subscriber')})
  const unsubscribe = service.onChange((c,s)=>changes.push([c.id,s]))
  await service.pollOnce()
  assert.deepEqual(service.get('one'), {status:'online',checkedAt:'2026-10-14T00:00:00.000Z'})
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
