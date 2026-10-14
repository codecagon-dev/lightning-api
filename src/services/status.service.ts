import { Socket } from 'node:net'
import type { ComputerRepository } from '../repositories/computer.repository.js'
import type { Computer, ComputerStatus, Status } from '../types.js'

export interface StatusOptions { now?: () => number }
const networkErrors = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'])

export function tcpProbe(computer: Computer, socketFactory: () => Socket = () => new Socket()): Promise<Status> {
  return new Promise(resolve => {
    let socket: Socket
    try { socket = socketFactory() } catch { resolve('unknown'); return }
    let settled = false
    const finish = (status: Status) => {
      if (settled) return
      settled = true
      socket.setTimeout(0)
      socket.removeListener('connect', connected)
      socket.removeListener('timeout', timedOut)
      socket.removeListener('error', failed)
      socket.removeListener('close', closed)
      socket.destroy()
      resolve(status)
    }
    const connected = () => finish('online')
    const timedOut = () => finish('offline')
    const closed = () => finish('offline')
    const failed = (error: NodeJS.ErrnoException) => finish(networkErrors.has(error.code ?? '') ? 'offline' : 'unknown')
    socket.once('connect', connected)
    socket.once('timeout', timedOut)
    socket.once('error', failed)
    socket.once('close', closed)
    try {
      socket.setTimeout(2_000)
      socket.connect({ host: computer.ipAddress, port: computer.sshPort })
    } catch { finish('unknown') }
  })
}

export class StatusService {
  private readonly cache = new Map<string, ComputerStatus>()
  private readonly listeners = new Set<(computer: Computer, status: ComputerStatus) => void>()
  private readonly now: () => number
  private timer?: ReturnType<typeof setInterval>
  private round?: Promise<void>

  constructor(private readonly repository: Pick<ComputerRepository, 'listAll'>,
    private readonly probe: (computer: Computer) => Promise<Status> = tcpProbe,
    options: StatusOptions = {}) { this.now = options.now ?? Date.now }

  get(computerId: string): ComputerStatus {
    return { ...(this.cache.get(computerId) ?? { status: 'unknown', checkedAt: null }) }
  }
  onChange(listener: (computer: Computer, status: ComputerStatus) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  pollOnce(): Promise<void> {
    if (this.round) return this.round
    // Defer work so the round guard is installed before a synchronous subscriber runs.
    const running = Promise.resolve().then(() => this.runRound())
    this.round = running.finally(() => { this.round = undefined })
    return this.round
  }
  start(): void {
    if (this.timer) return
    const poll = () => { void this.pollOnce().catch(() => { /* Retry repository failures next round without logging secrets. */ }) }
    this.timer = setInterval(poll, 10_000)
    poll()
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.round
  }
  private async runRound(): Promise<void> {
    const computers = this.repository.listAll()
    let cursor = 0
    const worker = async () => {
      while (cursor < computers.length) {
        const computer = computers[cursor++]!
        let status: Status
        try { status = await this.probe(computer) } catch { status = 'unknown' }
        const previous = this.get(computer.id).status
        const current = { status, checkedAt: new Date(this.now()).toISOString() }
        this.cache.set(computer.id, current)
        if (previous !== status) {
          for (const listener of this.listeners) {
            try { listener(computer, { ...current }) } catch { /* A broken client cannot interrupt polling. */ }
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(10, computers.length) }, worker))
  }
}
