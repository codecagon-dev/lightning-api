import { isIP } from 'node:net'
import { Hono } from 'hono'
import { createPowerActions, PowerError, type PowerActions } from '../services/ssh.service.js'
import type { Config } from '../config.js'
import type { ComputerStatus, Credentials } from '../types.js'
import { ComputerRepository, toPublicComputer, type ComputerInput } from '../repositories/computer.repository.js'
import { ApiError, type AuthService } from '../services/auth.service.js'
import { requireAuth, type AppEnv } from '../middleware/security.js'

const allowedFields = new Set(['name', 'os', 'ipAddress', 'macAddress', 'broadcastAddress', 'sshPort', 'wolPort', 'sshUsername', 'sshHostKeyFingerprint', 'sshPassword', 'sshPrivateKey', 'sshPrivateKeyPassphrase'])
const invalid = (): never => { throw new ApiError(400, 'Invalid computer input') }
function boundedString(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) return invalid()
  return value
}
function ipv4(value: unknown): string {
  if (typeof value !== 'string' || isIP(value) !== 4) return invalid()
  return value
}
function port(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) return invalid()
  return value
}

export function parseComputerInput(value: unknown, credentialLimitBytes = 32768): ComputerInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const body = value as Record<string, unknown>
  if (Object.keys(body).some(field => !allowedFields.has(field))) return invalid()
  const os = body.os === undefined ? 'linux' : body.os
  if (os !== 'linux' && os !== 'windows') return invalid()
  const name = boundedString(body.name, 100)
  const sshUsername = boundedString(body.sshUsername, 128)
  const ipAddress = ipv4(body.ipAddress)
  const broadcastAddress = ipv4(body.broadcastAddress)
  if (typeof body.macAddress !== 'string' || !/^(?:[a-fA-F\d]{2}:){5}[a-fA-F\d]{2}$|^(?:[a-fA-F\d]{2}-){5}[a-fA-F\d]{2}$/.test(body.macAddress)) return invalid()
  const macAddress = body.macAddress.toLowerCase().replaceAll('-', ':')
  const fp = body.sshHostKeyFingerprint
  if (typeof fp !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fp)) return invalid()
  const digest = Buffer.from(fp.slice(7), 'base64')
  if (digest.length !== 32 || digest.toString('base64').replace(/=+$/, '') !== fp.slice(7)) return invalid()
  const hasPassword = Object.hasOwn(body, 'sshPassword')
  const hasPrivateKey = Object.hasOwn(body, 'sshPrivateKey')
  if (hasPassword === hasPrivateKey || (hasPassword && Object.hasOwn(body, 'sshPrivateKeyPassphrase'))) return invalid()
  let credentials: Credentials
  if (hasPassword) {
    credentials = { sshPassword: boundedString(body.sshPassword, credentialLimitBytes) }
  } else {
    const sshPrivateKey = boundedString(body.sshPrivateKey, credentialLimitBytes)
    if (Object.hasOwn(body, 'sshPrivateKeyPassphrase') && typeof body.sshPrivateKeyPassphrase !== 'string') return invalid()
    credentials = { sshPrivateKey, ...(Object.hasOwn(body, 'sshPrivateKeyPassphrase') ? { sshPrivateKeyPassphrase: body.sshPrivateKeyPassphrase as string } : {}) }
  }
  // JSON escaping and UTF-8 can enlarge the combined payload beyond string lengths.
  if (Buffer.byteLength(JSON.stringify(credentials), 'utf8') > Math.min(credentialLimitBytes, 32768)) return invalid()
  return { name, os, ipAddress, macAddress, broadcastAddress,
    sshPort: port(body.sshPort, 22), wolPort: port(body.wolPort, 9),
    sshUsername, sshHostKeyFingerprint: fp, ...credentials }
}

export interface ComputerRouteDependencies {
  repository: ComputerRepository
  authService: AuthService
  config: Config
  power?: PowerActions
  status?: { get(computerId: string): ComputerStatus }
  onRegistered?: (ownerId: string) => void
}

export function computersRoutes(deps: ComputerRouteDependencies): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()
  routes.use('*', requireAuth(deps.authService, deps.config))
  routes.post('/', async c => {
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type') ?? '')) throw new ApiError(415, 'JSON body required')
    let body: unknown
    try { body = await c.req.json() } catch { return invalid() }
    const input = parseComputerInput(body, deps.config.credentialLimitBytes)
    const ownerId = c.get('session').userId
    const computer = deps.repository.create(ownerId, input)
    // Snapshot delivery is best-effort; a client failure must not undo registration.
    try { deps.onRegistered?.(ownerId) } catch {}
    return c.json({ computer: toPublicComputer(computer, { status: 'unknown', checkedAt: null }) }, 201)
  })
  routes.get('/', c => {
    const computers = deps.repository.listOwned(c.get('session').userId).map(computer =>
      toPublicComputer(computer, deps.status?.get(computer.id) ?? { status: 'unknown', checkedAt: null }))
    return c.json({ computers })
  })
  const power = deps.power ?? createPowerActions(deps.config)
  for (const [path, action] of [['on', 'wake'], ['off', 'shutdown']] as const) routes.post(`/:id/${path}`, async c => {
    const computer = deps.repository.findOwned(c.get('session').userId, c.req.param('id'))
    if (!computer) throw new ApiError(404, 'Not found')
    try { await power[action](computer) }
    catch (error) {
      throw new ApiError(error instanceof PowerError ? error.status : 502,
        error instanceof PowerError && error.status === 504 ? 'Power action timed out' : 'Power action failed')
    }
    return c.json({ ok: true }, 202)
  })
  return routes
}
