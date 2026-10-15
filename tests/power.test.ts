import { createAndLogin } from './helpers.js'
import { AuthLimitRepository } from '../src/repositories/auth-limit.repository.js'
import { test } from 'node:test'
import { createLogger } from '../src/logging.js'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { buildMagicPacket, sendWakePacket } from '../src/services/wol.service.js'
import { shutdownComputer, createPowerActions, PowerError } from '../src/services/ssh.service.js'
import type { Computer } from '../src/types.js'
import { openDatabase } from '../src/database.js'
import { loadConfig } from '../src/config.js'
import { UserRepository } from '../src/repositories/user.repository.js'
import { SessionRepository } from '../src/repositories/session.repository.js'
import { AuthService } from '../src/services/auth.service.js'
import { ComputerRepository } from '../src/repositories/computer.repository.js'
import { encryptCredentials } from '../src/services/credentials.service.js'
import { computersRoutes, parseComputerInput } from '../src/routes/computers.js'
import { createApp } from '../src/app.js'

const key = Buffer.from('known server public key')
const computer: Computer = {id:'computer', ownerId:'owner', color:null, name:'Office', os:'linux', ipAddress:'192.168.1.20', macAddress:'aa:bb:cc:dd:ee:ff', broadcastAddress:'192.168.1.255', sshPort:2222, wolPort:7, sshUsername:'operator', sshHostKeyFingerprint:'SHA256:'+createHash('sha256').update(key).digest('base64').replace(/=+$/,''), encryptedCredentials:'', createdAt:''}
class UDP extends EventEmitter {
  closed = 0; bound = false; broadcast = false; packet?: Buffer; destination?: [number,string]
  constructor(public mode = 'success') {super()}
  bind(callback: () => void) { if(this.mode === 'bind') throw new Error('secret'); this.bound=true; callback() }
  setBroadcast(enabled: boolean) {assert.equal(this.bound,true);this.broadcast=enabled; if(this.mode==='broadcast') throw new Error('secret')}
  send(packet: Buffer, port: number, address: string, callback: (error: Error | null) => void) {this.packet=packet; this.destination=[port,address]; if(this.mode==='timeout') return; if(this.mode==='event') this.emit('error',new Error('secret')); else callback(this.mode==='send'? new Error('secret'):null)}
  close() {this.closed++}
}
class SSH extends EventEmitter {
  ended=0; destroyed=0; commands:string[]=[]; options:any; stream = new EventEmitter() as any
  constructor(public mode='success',public presented=key) {super(); this.stream.stderr=new EventEmitter(); this.stream.stderr.resume=()=>{}; this.stream.resume=()=>{}; this.stream.destroy=()=>{} }
  connect(options:any) {
    this.options=options
    queueMicrotask(()=>{
      const verified=options.hostVerifier(this.presented)
      if(!verified) {this.emit('error',new Error('host secret')); return}
      if(this.mode==='connectTimeout') return
      if(this.mode==='login') {this.emit('error',Object.assign(new Error('password secret'), {level:'client-authentication'}));return}
      if(this.mode==='earlyClose'){this.emit('close');return}
      if(this.mode==='earlyEnd'){this.emit('end');return}
      this.emit('ready')
    }); return this
  }
  exec(command:string, callback:(error: Error|null, stream?:any)=>void) {
    this.commands.push(command)
    if(this.mode==='execError'){callback(new Error('secret'));return}
    callback(null,this.stream)
    queueMicrotask(()=>{
      if(this.mode==='commandTimeout') return
      if(this.mode==='disconnect'){this.emit('close');return}
      if(this.mode==='streamError'){this.stream.emit('error',new Error('secret'));return}
      this.stream.emit('exit',this.mode==='nonzero'?1:this.mode==='missingExit'?undefined:0)
      this.stream.emit('close')
    })
  }
  end(){this.ended++}
  destroy(){this.destroyed++}
}

test('WOL emits exactly six FF bytes then sixteen MAC copies and rejects invalid MAC',()=>{
  assert.equal(buildMagicPacket(computer.macAddress).toString('hex'),'ffffffffffff'+'aabbccddeeff'.repeat(16))
  assert.equal(buildMagicPacket(computer.macAddress).length,102)
  assert.throws(()=>buildMagicPacket('aa:bb:cc:dd:ee'))
})
test('WOL binds before enabling broadcast, sends to configured destination and closes on success',async()=>{
  const socket=new UDP(); await sendWakePacket(computer,{socketFactory:()=>socket,timeoutMs:20})
  assert.equal(socket.broadcast,true);assert.deepEqual(socket.destination,[7,'192.168.1.255']);assert.equal(socket.packet!.length,102);assert.equal(socket.closed,1)
})
for(const mode of ['bind','broadcast','send','event','timeout']) test('WOL cleans socket after '+mode,async()=>{
  const socket=new UDP(mode);await assert.rejects(sendWakePacket(computer,{socketFactory:()=>socket,timeoutMs:10}),e=>e instanceof PowerError && e.status===(mode==='timeout'?504:502) && e.reason===(mode==='timeout'?'udp_timeout':'udp_failed'));assert.equal(socket.closed,1)
})
for(const [os,command] of [['linux','sudo -n /sbin/shutdown -h now'],['windows','shutdown.exe /s /t 0']] as const) test('SSH verifies raw key and accepts exit zero for '+os,async()=>{
  const client=new SSH();await shutdownComputer({...computer,os},{sshPassword:'password'},{clientFactory:()=>client,connectTimeoutMs:30,commandTimeoutMs:30})
  assert.deepEqual(client.commands,[command]);assert.equal(client.options.hostHash,undefined);assert.equal(client.options.host,computer.ipAddress);assert.equal(client.options.port,2222);assert.equal(client.options.username,'operator');assert.equal(client.options.password,'password');assert.equal(client.ended,1)
})
test('SSH mismatched host key never executes even if ready is incorrectly emitted',async()=>{
  const client=new SSH('success',Buffer.from('unknown'));await assert.rejects(shutdownComputer(computer,{sshPassword:'secret'},{clientFactory:()=>client}),{status:502,reason:'hostkey_mismatch'});client.emit('ready');assert.deepEqual(client.commands,[]);assert.equal(client.destroyed,1)
})
test('SSH transport normalizes usernames before authentication without altering passwords', async () => {
  const client = new SSH()
  await shutdownComputer({ ...computer, sshUsername: '  DOMAIN\\Operator  ' }, { sshPassword: '  secret  ' }, { clientFactory: () => client })
  assert.equal(client.options.username, 'DOMAIN\\Operator')
  assert.equal(client.options.password, '  secret  ')
})
for(const mode of ['login','earlyClose','earlyEnd','connectTimeout','commandTimeout','nonzero','missingExit','disconnect','execError','streamError']) test('SSH rejects and cleans '+mode,async()=>{
  const client=new SSH(mode);await assert.rejects(shutdownComputer(computer,{sshPrivateKey:'key',sshPrivateKeyPassphrase:'phrase'},{clientFactory:()=>client,connectTimeoutMs:10,commandTimeoutMs:10}),e=>e instanceof PowerError&&e.status===(mode.endsWith('Timeout')?504:502)&&e.reason===(mode==='login'?'auth_failed':mode==='earlyClose'||mode==='earlyEnd'?'connect_failed':mode==='connectTimeout'?'connect_timeout':mode==='commandTimeout'?'command_timeout':'command_failed'));assert.equal(client.destroyed,1);assert.equal(client.options.privateKey,'key');assert.equal(client.options.passphrase,'phrase');if(mode==='login'||mode==='connectTimeout')assert.deepEqual(client.commands,[])
})
test('power endpoints isolate owners, await acceptance and sanitize failures; damaged encryption never starts SSH',async()=>{
 const db=openDatabase(':memory:');try{
 const config=loadConfig({FRONTEND_ORIGIN:'https://app.example',CREDENTIAL_ENCRYPTION_KEY:Buffer.alloc(32,1).toString('base64')})
 const auth=new AuthService(new UserRepository(db),new SessionRepository(db),config,new AuthLimitRepository(db))
 const a=await createAndLogin(auth, 'power-a@example.com','a long password!');const b=await createAndLogin(auth, 'power-b@example.com','a long password!')
 const repo=new ComputerRepository(db,(id,owner,c)=>encryptCredentials(config.credentialEncryptionKey,id,owner,c))
 const {id,ownerId,encryptedCredentials,createdAt,...input}=computer
 const saved=repo.create(a.user.id,parseComputerInput({...input,sshPassword:'secret'}))
 const lines:string[]=[];const logger=createLogger(line=>lines.push(line))
 let calls=0;let fail:Error|undefined;let gate:Promise<void>|undefined
 const power={wake:async()=>{calls++;await gate;if(fail)throw fail},shutdown:async()=>{calls++;if(fail)throw fail}}
 const app=createApp({config,authService:auth,logger,registerRoutes:app=>app.route('/computers',computersRoutes({config,authService:auth,repository:repo,power,logger}))})
 const request=(id:string,action:string,token=a.token)=>app.request(`/computers/${id}/${action}`,{method:'POST',headers:{cookie:`${config.sessionCookieName}=${token}`}})
 for(const action of ['on','off']){
 assert.equal((await request(saved.id,action,b.token)).status,404)
 assert.equal((await request('missing',action)).status,404)
 assert.equal(calls,0)
 }
 for(const action of ['on','off'])assert.equal((await request(saved.id,action)).status,202)
 assert.equal(calls,2)
 for(const alias of ['wake','shutdown'])assert.equal((await request(saved.id,alias)).status,404)
 assert.equal(calls,2)
 let release!:()=>void;gate=new Promise(resolve=>{release=resolve})
 let responded=false;const pending=request(saved.id,'on').then(response=>{responded=true;return response})
 await new Promise(resolve=>setImmediate(resolve));assert.equal(responded,false)
 release();assert.equal((await pending).status,202);gate=undefined
 fail=new Error('password key IP secret');const failed=await request(saved.id,'on');assert.equal(failed.status,502);assert.deepEqual(await failed.json(),{error:'Power action failed'})
 fail=new PowerError(504,'command_timeout');const timed=await request(saved.id,'off');assert.equal(timed.status,504);assert.deepEqual(await timed.json(),{error:'Power action timed out'})
 let sshCalls=0
 const defaultPower=createPowerActions(config,{clientFactory:()=>{sshCalls++;return new SSH()}})
 const app2=createApp({config,authService:auth,registerRoutes:app=>app.route('/computers',computersRoutes({config,authService:auth,repository:repo,power:defaultPower}))})
 db.prepare('UPDATE computers SET encrypted_credentials = ? WHERE id = ?').run('damaged',saved.id)
 await assert.rejects(defaultPower.shutdown(repo.findOwned(a.user.id,saved.id)!),{reason:'credential_decryption',status:502})
 const corrupt=await app2.request(`/computers/${saved.id}/off`,{method:'POST',headers:{cookie:`${config.sessionCookieName}=${a.token}`}})
 assert.equal(corrupt.status,502);assert.deepEqual(await corrupt.json(),{error:'Power action failed'});assert.equal(sshCalls,0)
 const actions=lines.map(line=>JSON.parse(line)).filter(e=>e.event==='power_action')
 assert.deepEqual(actions.map(e=>[e.action,e.outcome,e.reason]),[['on','success',undefined],['off','success',undefined],['on','success',undefined],['on','failure','unknown'],['off','failure','command_timeout']])
 assert.ok(actions.every(e=>e.computerId===saved.id))
 assert.equal(lines.join('').includes('secret'),false)
 fail=undefined
 logger.log=()=>{throw new Error('sink secret')}
 assert.equal((await request(saved.id,'on')).status,202)
 fail=new PowerError(504,'command_timeout')
 assert.equal((await request(saved.id,'off')).status,504)
 }finally{db.close()}
})

// Removing authentication/pinning or introducing command channels must break these diagnostics.
test('SSH diagnostic authenticates password and encrypted-key modes, closes immediately and never opens commands', async () => {
  const ssh = await import('../src/services/ssh.service.js')
  assert.equal(typeof (ssh as any).verifySshConnection, 'function')
  for (const credentials of [{ sshPassword: 'password' }, { sshPrivateKey: 'key', sshPrivateKeyPassphrase: 'phrase' }]) {
    const client = new SSH()
    const result = await (ssh as any).verifySshConnection(computer, credentials, { clientFactory: () => client })
    assert.deepEqual(result, { status: 'ready' })
    assert.equal(client.options.password, credentials.sshPassword)
    assert.equal(client.options.privateKey, credentials.sshPrivateKey)
    assert.equal(client.options.passphrase, credentials.sshPrivateKeyPassphrase)
    assert.deepEqual(client.commands, [])
    assert.equal(client.ended, 0)
    assert.equal(client.destroyed, 1)
  }
})

test('SSH diagnostics fail closed and clean clients for pinning, auth, disconnects, deadlines and synchronous errors', async () => {
  const ssh = await import('../src/services/ssh.service.js')
  assert.equal(typeof (ssh as any).verifySshConnection, 'function')
  for (const [mode, status] of [['mismatch','host_key_mismatch'], ['login','auth_failed'], ['earlyClose','unreachable'], ['earlyEnd','unreachable'], ['connectTimeout','unreachable'], ['throw','error'], ['unverified','host_key_mismatch']] as const) {
    const client = new SSH(mode, mode === 'mismatch' ? Buffer.from('untrusted') : key)
    if (mode === 'throw') client.connect = () => { throw new Error('credential secret') }
    if (mode === 'unverified') client.connect = () => { queueMicrotask(() => client.emit('ready')); return client }
    const result = await (ssh as any).verifySshConnection(computer, { sshPassword: 'secret' }, { clientFactory: () => client, connectTimeoutMs: 10 })
    assert.deepEqual(result, { status })
    client.emit('ready')
    assert.deepEqual(client.commands, [])
    assert.equal(client.destroyed, 1)
  }
})

test('saved credential diagnostics decrypt using record identity and damaged ciphertext blocks automatic retries without SSH', async () => {
  const ssh = await import('../src/services/ssh.service.js')
  assert.equal(typeof (ssh as any).createSshChecker, 'function')
  const config = loadConfig({ FRONTEND_ORIGIN: 'https://app.example', CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64') })
  const clients: SSH[] = []
  const check = (ssh as any).createSshChecker(config, { clientFactory: () => { const client = new SSH(); clients.push(client); return client } })
  const encryptedCredentials = encryptCredentials(config.credentialEncryptionKey, computer.id, computer.ownerId, { sshPassword: 'saved-secret' })
  assert.deepEqual(await check({ ...computer, encryptedCredentials }), { status: 'ready' })
  assert.equal(clients[0]!.options.password, 'saved-secret')
  assert.deepEqual(await check({ ...computer, encryptedCredentials: 'damaged' }), { status: 'error', retryBlocked: true })
  assert.equal(clients.length, 1)
})

test('diagnostic cleanup does not depend on graceful end', async () => {
  const ssh = await import('../src/services/ssh.service.js')
  const client = new SSH()
  client.end = () => { throw new Error('secret close failure') }
  await (ssh as any).verifySshConnection(computer, { sshPassword: 'secret' }, { clientFactory: () => client })
  assert.equal(client.destroyed, 1)
  assert.deepEqual(client.commands, [])
})

test('diagnostic completion destroys the writable transport directly without waiting for peer closure', async () => {
  const ssh = await import('../src/services/ssh.service.js')
  const client = new SSH()
  let connected = false, writable = true
  const connect = client.connect.bind(client)
  client.connect = options => { connected = true; return connect(options) }
  client.end = () => { client.ended++; writable = false; /* ssh2 end leaves the peer half open. */ }
  client.destroy = () => { client.destroyed++; if (writable) connected = false }
  const result = await (ssh as any).verifySshConnection(computer, { sshPassword: 'secret' }, { clientFactory: () => client })
  assert.deepEqual(result, { status: 'ready' })
  assert.equal(connected, false)
  assert.equal(client.ended, 0)
  assert.equal(client.destroyed, 1)
  assert.deepEqual(client.commands, [])
})
