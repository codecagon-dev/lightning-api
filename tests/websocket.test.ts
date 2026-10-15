import { createAndLogin } from './helpers.js'
import { AuthLimitRepository } from '../src/repositories/auth-limit.repository.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, IncomingMessage } from 'node:http'
import { Duplex } from 'node:stream'
import { WebSocket } from 'ws'
import { openDatabase } from '../src/database.js'
import { loadConfig } from '../src/config.js'
import { UserRepository } from '../src/repositories/user.repository.js'
import { SessionRepository } from '../src/repositories/session.repository.js'
import { ComputerRepository } from '../src/repositories/computer.repository.js'
import { AuthService } from '../src/services/auth.service.js'
import { StatusService } from '../src/services/status.service.js'
import { attachComputerWebSockets } from '../src/ws/computers.js'
import { computersRoutes } from '../src/routes/computers.js'
import { createApp } from '../src/app.js'

const flush=async()=>{ await new Promise<void>(resolve=>setImmediate(resolve)); await new Promise<void>(resolve=>setImmediate(resolve)) }
const input={name:'Office',color:null,os:'linux' as const,ipAddress:'192.168.1.2',macAddress:'aa:bb:cc:dd:ee:ff',broadcastAddress:'192.168.1.255',sshPort:22,wolPort:9,sshUsername:'operator',sshHostKeyFingerprint:`SHA256:${Buffer.alloc(32,7).toString('base64').replace(/=+$/,'')}`,sshPassword:'computer-secret'}

// Real ws handshake, framing and control frames over paired streams. No listen() is needed.
class Wire extends Duplex {
  peer?: Wire; response=''; handshake=false; hold=false
  _read() {}
  _write(chunk:Buffer,_encoding:string,done:(error?:Error|null)=>void) {
    if (this.handshake && chunk.toString().startsWith('HTTP/1.1')) { this.response+=chunk.toString(); done(); return }
    if (this.hold) return
    this.peer?.push(Buffer.from(chunk)); done()
  }
  _final(done:()=>void) { this.peer?.push(null); done() }
  _destroy(error:Error|null,done:(error:Error|null)=>void) { if (this.peer && !this.peer.destroyed) this.peer.destroy(); done(error) }
}
async function fixture() {
  let now=Date.parse('2026-10-14T00:00:00.000Z')
  const db=openDatabase(':memory:')
  const config=loadConfig({FRONTEND_ORIGIN:'https://app.example',CREDENTIAL_ENCRYPTION_KEY:Buffer.alloc(32,42).toString('base64')})
  const auth=new AuthService(new UserRepository(db),new SessionRepository(db),config,new AuthLimitRepository(db),{now:()=>now})
  const a=await createAndLogin(auth, 'a@example.com','a long password!'), b=await createAndLogin(auth, 'b@example.com','a long password!')
  const repository=new ComputerRepository(db,()=> 'encrypted-secret')
  const ca=repository.create(a.user.id,input), cb=repository.create(b.user.id,input)
  const status=new StatusService(repository,async()=> 'online',{now:()=>now,checkSsh:async()=>({status:'ready'})})
  const server=createServer()
  const controller=attachComputerWebSockets(server,{config,authService:auth,statusService:status,repository,now:()=>now})
  const sockets: WebSocket[]=[]
  const connect=async(token?:string,origin:string|null=config.frontendOrigin,url='/ws/computers',autoPong=true)=>{
    const outgoing=new Wire(), incoming=new Wire(); outgoing.peer=incoming; incoming.peer=outgoing; outgoing.handshake=true
    const client=new WebSocket(null as never,undefined,{autoPong,closeTimeout:10} as never)
    ;(client as any)._isServer=false
    const messages:any[]=[]
    client.on('message',data=>messages.push(JSON.parse(data.toString())))
    client.on('error',()=>{})
    ;(client as any).setSocket(incoming,Buffer.alloc(0),{allowSynchronousEvents:true,maxPayload:1024*1024,skipUTF8Validation:false})
    sockets.push(client)
    const request=new IncomingMessage(outgoing as any)
    request.method='GET'; request.url=url
    request.headers={upgrade:'websocket',connection:'Upgrade','sec-websocket-version':'13','sec-websocket-key':Buffer.alloc(16,7).toString('base64'),...(origin===null?{}:{origin}),...(token===undefined?{}:{cookie:`${config.sessionCookieName}=${token}`})}
    server.emit('upgrade',request,outgoing,Buffer.alloc(0))
    await flush()
    return {client,messages,outgoing,incoming}
  }
  const app=createApp({config,authService:auth,registerRoutes:app=>app.route('/computers',computersRoutes({config,authService:auth,repository,status,onRegistered:owner=>controller.sendSnapshot(owner)}))})
  return {db,config,auth,a,b,ca,cb,status,server,controller,connect,app,setNow:(n:number)=>{now=n},getNow:()=>now,close:async()=>{await controller.close();for(const client of sockets) client.terminate();await flush();await status.stop();db.close()}}
}

test('upgrade authenticates cookie before handshake, rejects incorrect Origin/path and ignores query tokens', async () => {
  const f=await fixture()
  try {
    for (const [token,origin,path,code] of [
      [undefined,f.config.frontendOrigin,'/ws/computers',401],['invalid',f.config.frontendOrigin,'/ws/computers',401],
      [f.a.token,'https://app.example.evil','/ws/computers',403],[f.a.token,'null','/ws/computers',403],
      [f.a.token,f.config.frontendOrigin,'/ws/computers/',404],
      [undefined,f.config.frontendOrigin,`/ws/computers?token=${f.a.token}`,404],
    ] as const) {
      const connection=await f.connect(token,origin,path)
      assert.match(connection.outgoing.response,new RegExp(`^HTTP/1.1 ${code}`))
      assert.equal(connection.messages.length,0)
    }
    const good=await f.connect(f.a.token)
    assert.match(good.outgoing.response,/^HTTP\/1.1 101/)
    assert.equal(good.messages[0].computers[0].id,f.ca.id)
    const nonBrowser=await f.connect(f.a.token,null)
    assert.match(nonBrowser.outgoing.response,/^HTTP\/1.1 101/)
  } finally { await f.close() }
})

test('rejected raw upgrades clean half-open sockets and contain socket/write failures', async t => {
  const f=await fixture()
  try {
    for (const mode of ['half-open','socket-error','write-throws'] as const) {
      await t.test(mode,async()=>{
        let response=''
        const failure=Object.assign(new Error('peer reset'),{code:'ECONNRESET'})
        const socket=new Duplex({allowHalfOpen:true,read(){},write(chunk,_encoding,done){
          response+=chunk.toString()
          if(mode==='write-throws') throw failure
          if(mode==='half-open') done()
          // Keep the write pending to represent a reset while sending the refusal.
        }})
        const request=new IncomingMessage(socket as any)
        request.method='GET';request.url='/invalid';request.headers={}
        try {
          assert.doesNotThrow(()=>f.server.emit('upgrade',request,socket,Buffer.alloc(0)))
          if(mode==='socket-error') assert.doesNotThrow(()=>socket.emit('error',failure))
          await flush()
          assert.match(response,/^HTTP\/1.1 404 Not Found\r\n/)
          assert.equal(socket.destroyed,true)
          assert.equal(socket.readable,false)
          assert.equal(socket.writable,false)
        } finally { socket.destroy() }
      })
    }
  } finally { await f.close() }
})

test('snapshots/updates contain only owned computers; registration refreshes owner and unchanged statuses stay silent', async () => {
  const f=await fixture()
  try {
    const a=await f.connect(f.a.token), b=await f.connect(f.b.token)
    assert.equal(a.messages[0].type,'snapshot');assert.equal(a.messages[0].computers.length,1)
    assert.equal(b.messages[0].computers[0].id,f.cb.id)
    assert.equal(a.messages[0].computers[0].status,'unknown')
    assert.equal(a.messages[0].computers[0].color,null)
    await f.status.pollOnce();await flush()
    assert.deepEqual(a.messages[1],{type:'status',computerId:f.ca.id,status:'online',checkedAt:'2026-10-14T00:00:00.000Z',sshStatus:'ready',sshCheckedAt:'2026-10-14T00:00:00.000Z'})
    assert.equal(b.messages[1].computerId,f.cb.id)
    f.setNow(f.getNow()+10000);await f.status.pollOnce();await flush()
    assert.equal(a.messages.length,2);assert.equal(b.messages.length,2)
    const response=await f.app.request('/computers',{method:'POST',headers:{cookie:`${f.config.sessionCookieName}=${f.a.token}`,'content-type':'application/json'},body:JSON.stringify({...input,name:'New'})})
    assert.equal(response.status,201);await flush()
    assert.equal(a.messages[2].computers.length,2);assert.equal(b.messages.length,2)
    const serialized=JSON.stringify([...a.messages,...b.messages])
    for (const secret of ['ownerId','encryptedCredentials','encrypted-secret','computer-secret',f.a.token]) assert.equal(serialized.includes(secret),false)
  } finally { await f.close() }
})

test('logout terminates only revoked session and idle expiry closes existing sockets without HTTP requests', async t=>{
  t.mock.timers.enable({apis:['setInterval']})
  const f=await fixture()
  try {
    const a=await f.connect(f.a.token), b=await f.connect(f.b.token)
    f.auth.logout(f.a.token);await flush()
    assert.equal(a.client.readyState,WebSocket.CLOSED);assert.equal(b.client.readyState,WebSocket.OPEN)
    f.setNow(f.getNow()+f.config.sessionLifetimeMs)
    t.mock.timers.tick(1000);await flush()
    assert.equal(b.client.readyState,WebSocket.CLOSED)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM sessions').get()!.count,0)
  } finally { await f.close() }
})

test('heartbeat preserves pong clients, removes silent clients and stop detaches listeners/timers', async t=>{
  t.mock.timers.enable({apis:['setInterval']})
  const f=await fixture()
  try {
    const silent=await f.connect(f.a.token,f.config.frontendOrigin,'/ws/computers',false), live=await f.connect(f.b.token)
    t.mock.timers.tick(30000);await flush()
    assert.equal(live.client.readyState,WebSocket.OPEN)
    t.mock.timers.tick(30000);await flush()
    assert.equal(silent.client.readyState,WebSocket.CLOSED);assert.equal(live.client.readyState,WebSocket.OPEN)
    await f.controller.close();await flush()
    assert.equal(live.client.readyState,WebSocket.CLOSED)
    assert.equal(f.server.listenerCount('upgrade'),0)
    t.mock.timers.tick(60000)
    await f.status.pollOnce()
    assert.equal(live.messages.length,1)
  } finally { await f.close() }
})

test('over-one-MiB buffer terminates slow client while polling and healthy delivery continue', async()=>{
  const f=await fixture()
  try {
    const slow=await f.connect(f.a.token),live=await f.connect(f.b.token)
    slow.outgoing.hold=true
    slow.outgoing.write(Buffer.alloc(1024*1024+1))
    await f.status.pollOnce();await flush()
    assert.equal(slow.client.readyState,WebSocket.CLOSED)
    assert.equal(live.client.readyState,WebSocket.OPEN)
    assert.equal(live.messages[1].computerId,f.cb.id)
    assert.equal(f.status.get(f.ca.id).status,'online')
  } finally { await f.close() }
})
