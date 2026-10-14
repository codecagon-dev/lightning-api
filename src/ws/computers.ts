import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { Config } from '../config.js'
import { toPublicComputer, type ComputerRepository } from '../repositories/computer.repository.js'
import type { AuthService, UserSession } from '../services/auth.service.js'
import type { StatusService } from '../services/status.service.js'

export interface WebSocketDependencies {
  config: Config
  authService: AuthService
  statusService: StatusService
  repository: Pick<ComputerRepository, 'listOwned'>
  now?: () => number
}
export interface ComputerWebSockets { close(): Promise<void>; sendSnapshot(ownerId: string): void }
interface Client { socket: WebSocket; session: UserSession; alive: boolean }
const MAX_BUFFER = 1024 * 1024

export function attachComputerWebSockets(server: Server, deps: WebSocketDependencies): ComputerWebSockets {
  const now = deps.now ?? Date.now
  const wsServer = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 })
  const clients = new Set<Client>()
  let closing: Promise<void> | undefined
  const remove = (client: Client) => {
    clients.delete(client)
    client.socket.terminate()
  }
  const valid = (client: Client) => {
    if (client.session.expiresAt <= now() || client.socket.readyState !== WebSocket.OPEN || client.socket.bufferedAmount > MAX_BUFFER) {
      remove(client)
      return false
    }
    return true
  }
  const send = (client: Client, message: unknown) => {
    if (!valid(client)) return
    try {
      client.socket.send(JSON.stringify(message), error => { if (error) remove(client) })
      if (client.socket.bufferedAmount > MAX_BUFFER) remove(client)
    } catch { remove(client) }
  }
  const snapshot = (client: Client) => send(client, {
    type: 'snapshot',
    computers: deps.repository.listOwned(client.session.userId).map(computer => toPublicComputer(computer, deps.statusService.get(computer.id))),
  })
  const unsubscribeStatus = deps.statusService.onChange((computer, status) => {
    for (const client of clients) {
      if (client.session.userId === computer.ownerId) send(client, { type: 'status', computerId: computer.id, ...status })
    }
  })
  const unsubscribeRevoke = deps.authService.onRevoke(sessionId => {
    for (const client of clients) if (client.session.sessionId === sessionId) remove(client)
  })
  const reject = (socket: Duplex, status: 400 | 401 | 403 | 404 | 500) => {
    const reason = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error' }[status]
    const destroy = () => { socket.destroy() }
    // HTTP relinquishes the raw socket on upgrade, including its error handling.
    socket.on('error', destroy)
    socket.once('finish', destroy)
    try { socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`) }
    catch { destroy() }
  }
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (request.url !== '/ws/computers') { reject(socket, 404); return }
    if (request.headers.origin !== undefined && request.headers.origin !== deps.config.frontendOrigin) { reject(socket, 403); return }
    const cookies = (request.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${deps.config.sessionCookieName}=`))
    let session: UserSession | null
    try { session = deps.authService.authenticate(cookies.length === 1 ? cookies[0]!.slice(deps.config.sessionCookieName.length + 1) : '') }
    catch { reject(socket, 500); return }
    if (!session) { reject(socket, 401); return }
    try {
      wsServer.handleUpgrade(request, socket, head, ws => {
        const client: Client = { socket: ws, session, alive: true }
        clients.add(client)
        ws.on('pong', () => { client.alive = true })
        ws.on('close', () => { clients.delete(client) })
        ws.on('error', () => remove(client))
        try { snapshot(client) } catch { remove(client) }
      })
    } catch { reject(socket, 400) }
  }
  server.on('upgrade', upgrade)
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!valid(client)) continue
      if (!client.alive) { remove(client); continue }
      client.alive = false
      try { client.socket.ping(undefined, undefined, error => { if (error) remove(client) }) } catch { remove(client) }
    }
  }, 30_000)
  // Expire idle sessions even when there are no HTTP requests or status transitions.
  const expiry = setInterval(() => {
    deps.authService.cleanupExpired()
    for (const client of clients) if (client.session.expiresAt <= now()) remove(client)
  }, 1_000)
  return {
    sendSnapshot(ownerId) {
      if (closing) return
      for (const client of clients) {
        if (client.session.userId === ownerId) { try { snapshot(client) } catch { remove(client) } }
      }
    },
    close() {
      if (closing) return closing
      server.removeListener('upgrade', upgrade)
      unsubscribeStatus()
      unsubscribeRevoke()
      clearInterval(heartbeat)
      clearInterval(expiry)
      for (const client of clients) remove(client)
      closing = new Promise<void>((resolve, rejectClose) => wsServer.close(error => error ? rejectClose(error) : resolve()))
      return closing
    },
  }
}
