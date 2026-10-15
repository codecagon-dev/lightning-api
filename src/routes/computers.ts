import { isIP } from 'node:net'
import { normalizeSshUsername } from '../ssh-username.js'
import { defaultLogger, log, powerReasons, type Logger } from '../logging.js'
import { Hono } from 'hono'
import { createPowerActions, PowerError, type PowerActions } from '../services/ssh.service.js'
import { decryptCredentials } from '../services/credentials.service.js'
import { unknownStatus, StatusCheckError } from '../services/status.service.js'
import type { Computer } from '../types.js'
import type { Config } from '../config.js'
import type { ComputerStatus, Credentials } from '../types.js'
import { ComputerRepository, toPublicComputer, type ComputerInput, type ComputerUpdate } from '../repositories/computer.repository.js'
import { ApiError, type AuthService } from '../services/auth.service.js'
import { requireAuth, type AppEnv } from '../middleware/security.js'

const allowedFields = new Set(['name', 'color', 'os', 'ipAddress', 'macAddress', 'broadcastAddress', 'sshPort', 'wolPort', 'sshUsername', 'sshHostKeyFingerprint', 'sshPassword', 'sshPrivateKey', 'sshPrivateKeyPassphrase'])
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

function computerBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const body = value as Record<string, unknown>
  if (Object.keys(body).some(field => !allowedFields.has(field))) return invalid()
  return body
}

function parseComputerFields(body: Record<string, unknown>): Omit<ComputerUpdate, 'credentials'> {
  const os = body.os === undefined ? 'linux' : body.os
  if (os !== 'linux' && os !== 'windows') return invalid()
  const name = boundedString(body.name, 100)
  if (body.color != null && (typeof body.color !== 'string' || !/^#[a-fA-F\d]{6}$/.test(body.color) || body.color.length !== 7)) return invalid()
  const color = typeof body.color === 'string' ? body.color.toLowerCase() : null
  let sshUsername: string
  try { sshUsername = normalizeSshUsername(body.sshUsername) } catch { return invalid() }
  const ipAddress = ipv4(body.ipAddress)
  const broadcastAddress = ipv4(body.broadcastAddress)
  if (typeof body.macAddress !== 'string' || !/^(?:[a-fA-F\d]{2}:){5}[a-fA-F\d]{2}$|^(?:[a-fA-F\d]{2}-){5}[a-fA-F\d]{2}$/.test(body.macAddress)) return invalid()
  const macAddress = body.macAddress.toLowerCase().replaceAll('-', ':')
  const fp = body.sshHostKeyFingerprint
  if (typeof fp !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fp)) return invalid()
  const digest = Buffer.from(fp.slice(7), 'base64')
  if (digest.length !== 32 || digest.toString('base64').replace(/=+$/, '') !== fp.slice(7)) return invalid()
  return { name, color, os, ipAddress, macAddress, broadcastAddress,
    sshPort: port(body.sshPort, 22), wolPort: port(body.wolPort, 9),
    sshUsername, sshHostKeyFingerprint: fp }
}

function parseCredentials(body: Record<string, unknown>, credentialLimitBytes: number): Credentials {
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
  return credentials
}

export function parseComputerInput(value: unknown, credentialLimitBytes = 32768): ComputerInput {
  const body = computerBody(value)
  return { ...parseComputerFields(body), ...parseCredentials(body, credentialLimitBytes) }
}

function parseComputerUpdate(value: unknown, current: Computer, config: Config): ComputerUpdate {
  const body = computerBody(value)
  if (Object.keys(body).length === 0) return invalid()
  const hasPassword = Object.hasOwn(body, 'sshPassword')
  const hasKey = Object.hasOwn(body, 'sshPrivateKey')
  const hasPassphrase = Object.hasOwn(body, 'sshPrivateKeyPassphrase')
  let credentials: Credentials | undefined
  if (hasPassword || hasKey) {
    // A supplied password or key replaces the entire previous credential mode.
    credentials = parseCredentials(body, config.credentialLimitBytes)
  } else if (hasPassphrase) {
    let stored: Credentials
    try { stored = decryptCredentials(config.credentialEncryptionKey, current.id, current.ownerId, current.encryptedCredentials) }
    catch { return invalid() }
    if (stored.sshPrivateKey === undefined) return invalid()
    credentials = parseCredentials({ sshPrivateKey: stored.sshPrivateKey,
      ...(body.sshPrivateKeyPassphrase === null ? {} : { sshPrivateKeyPassphrase: body.sshPrivateKeyPassphrase }) }, config.credentialLimitBytes)
  }
  const { id: _id, ownerId: _owner, encryptedCredentials: _encrypted, createdAt: _created, ...fields } = current
  // Creation and updates share field normalization and credential-size rules.
  return { ...parseComputerFields({ ...fields, ...body }), ...(credentials === undefined ? {} : { credentials }) }
}

export interface ComputerRouteDependencies {
  logger?: Logger
  repository: ComputerRepository
  authService: AuthService
  config: Config
  power?: PowerActions
  status?: { get(computerId: string): ComputerStatus; checkSsh?(computer: Computer): Promise<ComputerStatus> }
  onRegistered?: (ownerId: string) => void
  onUpdated?: (ownerId: string, computerId: string) => void
  onDeleted?: (ownerId: string, computerId: string) => void
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
    return c.json({ computer: toPublicComputer(computer, unknownStatus()) }, 201)
  })
  routes.get('/', c => {
    const computers = deps.repository.listOwned(c.get('session').userId).map(computer =>
      toPublicComputer(computer, deps.status?.get(computer.id) ?? unknownStatus()))
    return c.json({ computers })
  })
  routes.patch('/:id', async c => {
    const ownerId = c.get('session').userId
    const id = c.req.param('id')
    if (!deps.repository.findOwned(ownerId, id)) throw new ApiError(404, 'Not found')
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type') ?? '')) throw new ApiError(415, 'JSON body required')
    let body: unknown
    try { body = await c.req.json() } catch { return invalid() }
    // Body reading yields. Merge only with the latest owned row, synchronously with the update.
    const current = deps.repository.findOwned(ownerId, id)
    if (!current) throw new ApiError(404, 'Not found')
    const input = parseComputerUpdate(body, current, deps.config)
    const computer = deps.repository.updateOwned(ownerId, id, input)
    if (!computer) throw new ApiError(404, 'Not found')
    try { deps.onUpdated?.(ownerId, id) } catch {}
    return c.json({ computer: toPublicComputer(computer, deps.status?.get(id) ?? unknownStatus()) })
  })
  routes.delete('/:id', c => {
    const ownerId = c.get('session').userId
    const id = c.req.param('id')
    if (!deps.repository.deleteOwned(ownerId, id)) throw new ApiError(404, 'Not found')
    try { deps.onDeleted?.(ownerId, id) } catch {}
    return c.body(null, 204)
  })
  routes.post('/:id/check-ssh', async c => {
    const ownerId = c.get('session').userId
    let computer = deps.repository.findOwned(ownerId, c.req.param('id'))
    if (!computer) throw new ApiError(404, 'Not found')
    if ((await c.req.text()).length !== 0) throw new ApiError(400, 'Empty body required')
    if (!deps.status?.checkSsh) throw new ApiError(503, 'SSH check unavailable')
    // Body reading yields: deletion may have happened before check admission.
    computer = deps.repository.findOwned(ownerId, computer.id)
    if (!computer) throw new ApiError(404, 'Not found')
    let diagnostic: ComputerStatus
    try { diagnostic = await deps.status.checkSsh(computer) }
    catch (error) {
      if (!deps.repository.findOwned(ownerId, computer.id) || (error instanceof StatusCheckError && error.status === 404)) throw new ApiError(404, 'Not found')
      if (error instanceof StatusCheckError && error.status === 429) throw new ApiError(429, 'Too many requests')
      throw new ApiError(503, 'SSH check unavailable')
    }
    if (!deps.repository.findOwned(ownerId, computer.id)) throw new ApiError(404, 'Not found')
    return c.json({ computerId: computer.id, ...diagnostic })
  })
  const power = deps.power ?? createPowerActions(deps.config)
  for (const [path, action] of [['on', 'wake'], ['off', 'shutdown']] as const) routes.post(`/:id/${path}`, async c => {
    const computer = deps.repository.findOwned(c.get('session').userId, c.req.param('id'))
    if (!computer) throw new ApiError(404, 'Not found')
    try { await power[action](computer) }
    catch (error) {
      log(deps.logger ?? defaultLogger, 'error', { event: 'power_action', action: path,
        computerId: computer.id, outcome: 'failure',
        reason: error instanceof PowerError && powerReasons.includes(error.reason) ? error.reason : 'unknown' })
      throw new ApiError(error instanceof PowerError ? error.status : 502,
        error instanceof PowerError && error.status === 504 ? 'Power action timed out' : 'Power action failed')
    }
    log(deps.logger ?? defaultLogger, 'info', { event: 'power_action', action: path, computerId: computer.id, outcome: 'success' })
    return c.json({ ok: true }, 202)
  })
  return routes
}
