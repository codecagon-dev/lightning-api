import { createHash, timingSafeEqual } from 'node:crypto'
import { Client, type ConnectConfig } from 'ssh2'
import type { Config } from '../config.js'
import type { Computer, Credentials, SshStatus } from '../types.js'
import { decryptCredentials } from './credentials.service.js'
import { PowerError, sendWakePacket, type WakeOptions } from './wol.service.js'
export { PowerError } from './wol.service.js'

export interface ShutdownStream {
  on(event: string, listener: (...args: any[]) => void): unknown
  resume(): unknown
  stderr: { resume(): unknown }
  destroy(): unknown
}
export interface SshClient {
  on(event: string, listener: (...args: any[]) => void): unknown
  connect(options: ConnectConfig): unknown
  end(): unknown
  destroy(): unknown
}
export interface ShutdownClient extends SshClient {
  exec(command: string, callback: (error: Error | undefined | null, stream?: ShutdownStream) => void): unknown
}
export interface ShutdownOptions {
  clientFactory?: () => ShutdownClient
  connectTimeoutMs?: number
  commandTimeoutMs?: number
}
export interface PowerActions { wake(computer: Computer): Promise<void>; shutdown(computer: Computer): Promise<void> }
export interface SshVerification { status: Exclude<SshStatus, 'unknown'>; retryBlocked?: boolean }
export type SshChecker = (computer: Computer) => Promise<SshVerification>
export interface SshCheckOptions { clientFactory?: () => SshClient; connectTimeoutMs?: number }

// Both diagnostics and shutdown use the same pinning, credentials and cleanup lifecycle.
function sshSession(computer: Computer, credentials: Credentials, options: SshCheckOptions & { commandTimeoutMs?: number }, shutdown: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    let client: SshClient | undefined
    let stream: ShutdownStream | undefined
    let settled = false
    let verified = false
    let started = false
    let exitCode: number | undefined
    let timer: ReturnType<typeof setTimeout>
    const finish = (error?: PowerError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { stream?.destroy() } catch {}
      // Diagnostics have no channels or pending output. Destroy directly:
      // ssh2 end() makes its socket non-writable, disabling a later destroy().
      try { error || !shutdown ? client?.destroy() : client?.end() } catch {}
      error ? reject(error) : resolve()
    }
    timer = setTimeout(() => finish(new PowerError(504, 'connect_timeout')), options.connectTimeoutMs ?? 10000)
    try {
      client = (options.clientFactory ?? (() => new Client()))()
      client.on('error', (error: unknown) => finish(new PowerError(502,
        error && typeof error === 'object' && 'level' in error && error.level === 'client-authentication'
          ? 'auth_failed' : started ? 'command_failed' : 'connect_failed')))
      client.on('close', () => finish(new PowerError(502, started ? 'command_failed' : 'connect_failed')))
      client.on('end', () => finish(new PowerError(502, started ? 'command_failed' : 'connect_failed')))
      client.on('ready', () => {
        if (settled || started) return
        if (!verified) { finish(new PowerError(502, 'hostkey_mismatch')); return }
        if (!shutdown) { finish(); return }
        started = true
        clearTimeout(timer)
        timer = setTimeout(() => finish(new PowerError(504, 'command_timeout')), options.commandTimeoutMs ?? 10000)
        try {
          (client as ShutdownClient).exec(computer.os === 'windows' ? 'shutdown.exe /s /t 0' : 'sudo -n /sbin/shutdown -h now', (error, channel) => {
            if (settled) { try { channel?.destroy() } catch {}; return }
            if (error || !channel) { finish(new PowerError(502, 'command_failed')); return }
            stream = channel
            stream.on('error', () => finish(new PowerError(502, 'command_failed')))
            stream.on('exit', (code: number | undefined) => { exitCode = code })
            stream.on('close', () => finish(exitCode === 0 ? undefined : new PowerError(502, 'command_failed')))
            // Drain both streams without retaining or logging potentially sensitive output.
            stream.resume()
            stream.stderr.resume()
          })
        } catch { finish(new PowerError(502, started ? 'command_failed' : 'connect_failed')) }
      })
      client.connect({ host: computer.ipAddress, port: computer.sshPort, username: computer.sshUsername,
        readyTimeout: options.connectTimeoutMs ?? 10000,
        ...(credentials.sshPassword !== undefined ? { password: credentials.sshPassword } : { privateKey: credentials.sshPrivateKey, passphrase: credentials.sshPrivateKeyPassphrase }),
        hostVerifier: (rawKey: Buffer) => {
          if (settled || !Buffer.isBuffer(rawKey)) return false
          const actual = Buffer.from('SHA256:' + createHash('sha256').update(rawKey).digest('base64').replace(/=+$/, ''))
          const expected = Buffer.from(computer.sshHostKeyFingerprint)
          verified = actual.length === expected.length && timingSafeEqual(actual, expected)
          if (!verified) finish(new PowerError(502, 'hostkey_mismatch'))
          return verified
        },
      })
    } catch { finish(new PowerError(502, shutdown ? started ? 'command_failed' : 'connect_failed' : 'unknown')) }
  })
}
export function shutdownComputer(computer: Computer, credentials: Credentials, options: ShutdownOptions = {}): Promise<void> {
  return sshSession(computer, credentials, options, true)
}
export async function verifySshConnection(computer: Computer, credentials: Credentials, options: SshCheckOptions = {}): Promise<SshVerification> {
  try { await sshSession(computer, credentials, options, false); return { status: 'ready' } }
  catch (error) {
    const reason = error instanceof PowerError ? error.reason : undefined
    return { status: reason === 'auth_failed' ? 'auth_failed' : reason === 'hostkey_mismatch' ? 'host_key_mismatch'
      : reason === 'connect_timeout' || reason === 'connect_failed' ? 'unreachable' : 'error' }
  }
}
export function createSshChecker(config: Config, options: SshCheckOptions = {}): SshChecker {
  return async computer => {
    let credentials: Credentials
    try { credentials = decryptCredentials(config.credentialEncryptionKey, computer.id, computer.ownerId, computer.encryptedCredentials) }
    catch { return { status: 'error', retryBlocked: true } }
    return verifySshConnection(computer, credentials, { connectTimeoutMs: config.sshConnectTimeoutMs, ...options })
  }
}
export function createPowerActions(config: Config, options: ShutdownOptions & WakeOptions = {}): PowerActions {
  return {
    wake: computer => sendWakePacket(computer, options),
    shutdown: async computer => {
      let credentials: Credentials
      try { credentials = decryptCredentials(config.credentialEncryptionKey, computer.id, computer.ownerId, computer.encryptedCredentials) }
      catch { throw new PowerError(502, 'credential_decryption') }
      await shutdownComputer(computer, credentials, { connectTimeoutMs: config.sshConnectTimeoutMs, commandTimeoutMs: config.sshCommandTimeoutMs, ...options })
    },
  }
}
