import { createHash, timingSafeEqual } from 'node:crypto'
import { Client, type ConnectConfig } from 'ssh2'
import type { Config } from '../config.js'
import type { Computer, Credentials } from '../types.js'
import { decryptCredentials } from './credentials.service.js'
import { PowerError, sendWakePacket, type WakeOptions } from './wol.service.js'
export { PowerError } from './wol.service.js'

export interface ShutdownStream {
  on(event: string, listener: (...args: any[]) => void): unknown
  resume(): unknown
  stderr: { resume(): unknown }
  destroy(): unknown
}
export interface ShutdownClient {
  on(event: string, listener: (...args: any[]) => void): unknown
  connect(options: ConnectConfig): unknown
  exec(command: string, callback: (error: Error | undefined | null, stream?: ShutdownStream) => void): unknown
  end(): unknown
  destroy(): unknown
}
export interface ShutdownOptions {
  clientFactory?: () => ShutdownClient
  connectTimeoutMs?: number
  commandTimeoutMs?: number
}
export interface PowerActions { wake(computer: Computer): Promise<void>; shutdown(computer: Computer): Promise<void> }
export function shutdownComputer(computer: Computer, credentials: Credentials, options: ShutdownOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    let client: ShutdownClient | undefined
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
      try { error ? client?.destroy() : client?.end() } catch {}
      error ? reject(error) : resolve()
    }
    timer = setTimeout(() => finish(new PowerError(504)), options.connectTimeoutMs ?? 10000)
    try {
      client = (options.clientFactory ?? (() => new Client()))()
      client.on('error', () => finish(new PowerError(502)))
      client.on('close', () => finish(new PowerError(502)))
      client.on('end', () => finish(new PowerError(502)))
      client.on('ready', () => {
        if (settled || started) return
        if (!verified) { finish(new PowerError(502)); return }
        started = true
        clearTimeout(timer)
        timer = setTimeout(() => finish(new PowerError(504)), options.commandTimeoutMs ?? 10000)
        try {
          client!.exec(computer.os === 'windows' ? 'shutdown.exe /s /t 0' : 'sudo -n /sbin/shutdown -h now', (error, channel) => {
            if (settled) { try { channel?.destroy() } catch {}; return }
            if (error || !channel) { finish(new PowerError(502)); return }
            stream = channel
            stream.on('error', () => finish(new PowerError(502)))
            stream.on('exit', (code: number | undefined) => { exitCode = code })
            stream.on('close', () => finish(exitCode === 0 ? undefined : new PowerError(502)))
            // Drain both streams without retaining or logging potentially sensitive output.
            stream.resume()
            stream.stderr.resume()
          })
        } catch { finish(new PowerError(502)) }
      })
      client.connect({ host: computer.ipAddress, port: computer.sshPort, username: computer.sshUsername,
        readyTimeout: options.connectTimeoutMs ?? 10000,
        ...(credentials.sshPassword !== undefined ? { password: credentials.sshPassword } : { privateKey: credentials.sshPrivateKey, passphrase: credentials.sshPrivateKeyPassphrase }),
        hostVerifier: (rawKey: Buffer) => {
          if (settled || !Buffer.isBuffer(rawKey)) return false
          const actual = Buffer.from('SHA256:' + createHash('sha256').update(rawKey).digest('base64').replace(/=+$/, ''))
          const expected = Buffer.from(computer.sshHostKeyFingerprint)
          verified = actual.length === expected.length && timingSafeEqual(actual, expected)
          if (!verified) finish(new PowerError(502))
          return verified
        },
      })
    } catch { finish(new PowerError(502)) }
  })
}
export function createPowerActions(config: Config, options: ShutdownOptions & WakeOptions = {}): PowerActions {
  return {
    wake: computer => sendWakePacket(computer, options),
    shutdown: async computer => {
      let credentials: Credentials
      try { credentials = decryptCredentials(config.credentialEncryptionKey, computer.id, computer.ownerId, computer.encryptedCredentials) }
      catch { throw new PowerError(502) }
      await shutdownComputer(computer, credentials, { connectTimeoutMs: config.sshConnectTimeoutMs, commandTimeoutMs: config.sshCommandTimeoutMs, ...options })
    },
  }
}
