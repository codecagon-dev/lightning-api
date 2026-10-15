import { createSocket } from 'node:dgram'
import type { PowerReason } from '../logging.js'
import type { Computer } from '../types.js'

export class PowerError extends Error {
  constructor(public readonly status: 502 | 504 = 502, public readonly reason: PowerReason = 'unknown') { super(status === 504 ? 'Power action timed out' : 'Power action failed') }
}
export interface WakeSocket {
  on(event: 'error', listener: (error: Error) => void): unknown
  bind(callback: () => void): unknown
  setBroadcast(enabled: boolean): unknown
  send(packet: Buffer, port: number, address: string, callback: (error: Error | null) => void): unknown
  close(): unknown
}
export interface WakeOptions { socketFactory?: () => WakeSocket; timeoutMs?: number }
export function buildMagicPacket(macAddress: string): Buffer {
  if (!/^(?:[a-f\d]{2}:){5}[a-f\d]{2}$|^(?:[a-f\d]{2}-){5}[a-f\d]{2}$/i.test(macAddress)) throw new PowerError(502, 'udp_failed')
  const mac = Buffer.from(macAddress.replace(/[:-]/g, ''), 'hex')
  return Buffer.concat([Buffer.alloc(6, 255), ...Array.from({ length: 16 }, () => mac)])
}
export function sendWakePacket(computer: Computer, options: WakeOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    let socket: WakeSocket | undefined
    let settled = false
    const finish = (error?: PowerError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket?.close() } catch {}
      error ? reject(error) : resolve()
    }
    const timer = setTimeout(() => finish(new PowerError(504, 'udp_timeout')), options.timeoutMs ?? 10000)
    try {
      const packet = buildMagicPacket(computer.macAddress)
      socket = (options.socketFactory ?? (() => createSocket('udp4')))()
      socket.on('error', () => finish(new PowerError(502, 'udp_failed')))
      socket.bind(() => {
        if (settled) return
        try {
          socket!.setBroadcast(true)
          socket!.send(packet, computer.wolPort, computer.broadcastAddress, error => finish(error ? new PowerError(502, 'udp_failed') : undefined))
        } catch { finish(new PowerError(502, 'udp_failed')) }
      })
    } catch { finish(new PowerError(502, 'udp_failed')) }
  })
}
