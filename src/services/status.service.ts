import { Socket } from 'node:net'
import type { ComputerRepository } from '../repositories/computer.repository.js'
import { defaultLogger, log, type Logger } from '../logging.js'
import type { SshChecker } from './ssh.service.js'
import type { Computer, ComputerStatus, Status } from '../types.js'

export interface StatusOptions { now?: () => number; checkSsh?: SshChecker; logger?: Logger }
export class StatusCheckError extends Error {
  constructor(public readonly status: 404 | 429 | 503) { super('SSH check unavailable') }
}
export const unknownStatus = (): ComputerStatus => ({ status: 'unknown', checkedAt: null, sshStatus: 'unknown', sshCheckedAt: null })
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
  private readonly removedDuringRound = new Set<string>()
  private readonly generations = new Map<string, number>()
  private readonly invalidated = new Map<string, 404 | 503>()
  private readonly cache = new Map<string, ComputerStatus>()
  private readonly manualRequested = new Set<string>()
  private readonly blocked = new Set<string>()
  private readonly inFlight = new Map<string, Promise<ComputerStatus>>()
  private readonly listeners = new Set<(computer: Computer, status: ComputerStatus) => void>()
  private readonly now: () => number
  private timer?: ReturnType<typeof setInterval>
  private round?: Promise<void>
  private stopped = false

  constructor(private readonly repository: Pick<ComputerRepository, 'listAll'>,
    private readonly probe: (computer: Computer) => Promise<Status> = tcpProbe,
    private readonly options: StatusOptions = {}) { this.now = options.now ?? Date.now }

  get(computerId: string): ComputerStatus { return { ...(this.cache.get(computerId) ?? unknownStatus()) } }
  remove(computerId: string): void { this.invalidate(computerId, 404) }
  // Edits conservatively reset all observations and SSH retry latches. Keep active work
  // counted until it settles; queued rows from this round must not use old credentials.
  update(computerId: string): void { this.invalidate(computerId, 503) }
  private invalidate(computerId: string, reason: 404 | 503): void {
    this.cache.delete(computerId)
    this.blocked.delete(computerId)
    if (this.inFlight.has(computerId)) {
      this.generations.set(computerId, (this.generations.get(computerId) ?? 0) + 1)
      this.invalidated.set(computerId, reason)
    }
    if (this.round) this.removedDuringRound.add(computerId)
  }
  onChange(listener: (computer: Computer, status: ComputerStatus) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  checkSsh(computer: Computer): Promise<ComputerStatus> {
    if (!this.options.checkSsh) return Promise.reject(new StatusCheckError(503))
    return this.check(computer, true)
  }
  private check(computer: Computer, manual: boolean): Promise<ComputerStatus> {
    if (this.stopped) return Promise.reject(new StatusCheckError(503))
    const existing = this.inFlight.get(computer.id)
    if (existing && this.invalidated.has(computer.id)) return Promise.reject(new StatusCheckError(this.invalidated.get(computer.id)!))
    if (existing) { if (manual) this.manualRequested.add(computer.id); return existing }
    if (this.inFlight.size >= 10) return Promise.reject(new StatusCheckError(429))
    if (manual) this.manualRequested.add(computer.id)
    const generation = this.generations.get(computer.id) ?? 0
    const currentGeneration = () => (this.generations.get(computer.id) ?? 0) === generation
    // Install the guard before invoking adapters or subscribers.
    const running = Promise.resolve().then(async () => {
      if (!currentGeneration()) throw new StatusCheckError(this.invalidated.get(computer.id) ?? 404)
      if (this.stopped) throw new StatusCheckError(503)
      const previous = this.get(computer.id)
      let status: Status
      try { status = await this.probe(computer) } catch { status = 'unknown' }
      if (!currentGeneration()) throw new StatusCheckError(this.invalidated.get(computer.id) ?? 404)
      if (this.stopped && this.manualRequested.has(computer.id)) throw new StatusCheckError(503)
      const current: ComputerStatus = { ...previous, status, checkedAt: new Date(this.now()).toISOString() }
      if (status !== 'online') {
        current.sshStatus = status === 'offline' ? 'unreachable' : 'unknown'
      } else {
        if (previous.status !== 'online') current.sshStatus = 'unknown'
        const due = previous.sshCheckedAt === null || this.now() - Date.parse(previous.sshCheckedAt) >= 60_000
        if (!this.stopped && this.options.checkSsh && (this.manualRequested.has(computer.id) || (due && !this.blocked.has(computer.id)))) {
          // This timestamp describes the actual full attempt, never a TCP poll.
          current.sshCheckedAt = new Date(this.now()).toISOString()
          let result: Awaited<ReturnType<SshChecker>>
          try { result = await this.options.checkSsh(computer) } catch { result = { status: 'error' } }
          if (!currentGeneration()) throw new StatusCheckError(this.invalidated.get(computer.id) ?? 404)
          current.sshStatus = result.status
          if (result.retryBlocked || result.status === 'auth_failed' || result.status === 'host_key_mismatch') this.blocked.add(computer.id)
          else this.blocked.delete(computer.id)
          log(this.options.logger ?? defaultLogger, result.status === 'ready' ? 'info' : 'warn', {
            event: 'ssh_check', computerId: computer.id, outcome: result.status,
          })
        }
      }
      if (!currentGeneration()) throw new StatusCheckError(this.invalidated.get(computer.id) ?? 404)
      this.cache.set(computer.id, current)
      if (previous.status !== current.status || previous.sshStatus !== current.sshStatus) {
        for (const listener of this.listeners) {
          try { listener(computer, { ...current }) } catch { /* A broken client cannot interrupt checking. */ }
        }
      }
      return { ...current }
    })
    const completion = running.finally(() => { this.inFlight.delete(computer.id); this.generations.delete(computer.id); this.invalidated.delete(computer.id); this.manualRequested.delete(computer.id) })
    this.inFlight.set(computer.id, completion)
    return completion
  }
  pollOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.round) return this.round
    const running = Promise.resolve().then(() => this.runRound())
    this.round = running.finally(() => { this.round = undefined; this.removedDuringRound.clear() })
    return this.round
  }
  start(): void {
    if (this.timer) return
    this.stopped = false
    const poll = () => { void this.pollOnce().catch(() => { /* Retry repository failures next round without logging secrets. */ }) }
    this.timer = setInterval(poll, 10_000)
    poll()
  }
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await Promise.allSettled([...(this.round ? [this.round] : []), ...this.inFlight.values()])
  }
  private async runRound(): Promise<void> {
    const computers = this.repository.listAll()
    let cursor = 0
    const worker = async () => {
      while (!this.stopped && cursor < computers.length) {
        const computer = computers[cursor++]!
        if (this.removedDuringRound.has(computer.id)) continue
        try { await this.check(computer, false) } catch { /* Deleted, stopped, or full: skip safely and retry a later round. */ }
      }
    }
    await Promise.all(Array.from({ length: Math.min(10, computers.length) }, worker))
  }
}
