import { AuthLimitRepository } from './repositories/auth-limit.repository.js'
import { createServer, type Server } from 'node:http'
import { defaultLogger, log, startupFailure, type Logger } from './logging.js'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getRequestListener } from '@hono/node-server'
import { config as loadEnvironment } from 'dotenv'
import { createApp } from './app.js'
import { loadConfig, type Config } from './config.js'
import { openDatabase } from './database.js'
import { UserRepository } from './repositories/user.repository.js'
import { SessionRepository } from './repositories/session.repository.js'
import { ComputerRepository } from './repositories/computer.repository.js'
import { AuthService } from './services/auth.service.js'
import { encryptCredentials } from './services/credentials.service.js'
import { createPowerActions, createSshChecker, type SshChecker, type PowerActions } from './services/ssh.service.js'
import { StatusService } from './services/status.service.js'
import { computersRoutes } from './routes/computers.js'
import { attachComputerWebSockets } from './ws/computers.js'
import type { Computer, Status } from './types.js'

export interface RuntimeOptions {
  logger?: Logger
  power?: PowerActions
  probe?: (computer: Computer) => Promise<Status>
  checkSsh?: SshChecker
}

function closeHttp(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    // Allow accepted requests to finish, then bound shutdown of stalled clients.
    const deadline = setTimeout(() => server.closeAllConnections(), 10_000)
    deadline.unref()
    server.close(error => {
      clearTimeout(deadline)
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
      else resolveClose()
    })
    server.closeIdleConnections()
  })
}

/** Compose once; tests can use app.request and server upgrade events without listen(). */
export function createRuntime(config: Config, options: RuntimeOptions = {}) {
  const logger = options.logger ?? defaultLogger
  const database = openDatabase(config.databasePath)
  try {
    const authService = new AuthService(new UserRepository(database), new SessionRepository(database), config, new AuthLimitRepository(database))
    const repository = new ComputerRepository(database, (id, owner, credentials) =>
      encryptCredentials(config.credentialEncryptionKey, id, owner, credentials))
    const statusService = new StatusService(repository, options.probe, { checkSsh: options.checkSsh ?? createSshChecker(config), logger })
    const power = options.power ?? createPowerActions(config)
    let controller: ReturnType<typeof attachComputerWebSockets>
    const app = createApp({ config, authService, logger, registerRoutes: app => {
      app.route('/computers', computersRoutes({ config, authService, repository, power, logger,
        status: statusService, onRegistered: owner => controller.sendSnapshot(owner),
        onUpdated: (owner, id) => { statusService.update(id); controller.sendSnapshot(owner) },
        onDeleted: (owner, id) => { statusService.remove(id); controller.sendSnapshot(owner) } }))
    } })
    const server = createServer(getRequestListener(app.fetch))
    controller = attachComputerWebSockets(server, { config, authService, repository, statusService })
    let stopping: Promise<void> | undefined
    const stop = () => stopping ??= (async () => {
      log(logger, 'info', { event: 'shutdown_started' })
      try { await statusService.stop() }
      finally {
        try { await controller.close() }
        finally { try { await closeHttp(server) } finally { database.close() } }
      }
    })().then(() => { log(logger, 'info', { event: 'shutdown_complete' }) }, error => {
      log(logger, 'error', { event: 'shutdown_failed', reason: 'shutdown_error' })
      throw error
    })
    statusService.start()
    return { app, server, database, authService, statusService, stop }
  } catch (error) { database.close(); throw error }
}

/** Bind the real HTTP server; failed binding releases all composed resources. */
export async function startRuntime(config: Config, options: RuntimeOptions = {}) {
  const runtime = createRuntime(config, options)
  try {
    await new Promise<void>((ready, reject) => {
      runtime.server.once('error', reject)
      runtime.server.listen(config.port, config.host, () => {
        runtime.server.removeListener('error', reject)
        ready()
      })
    })
    log(options.logger ?? defaultLogger, 'info', { event: 'startup' })
    return runtime
  } catch (error) { await runtime.stop(); throw error }
}

async function main() {
  loadEnvironment({ quiet: true })
  const config = loadConfig(process.env)
  const runtime = await startRuntime(config)
  const shutdown = () => {
    void runtime.stop().catch(() => { process.exitCode = 1 }).finally(() => {
      process.removeListener('SIGINT', shutdown)
      process.removeListener('SIGTERM', shutdown)
    })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(error => {
    log(defaultLogger, 'error', { event: 'startup_failed', ...startupFailure(error) })
    process.exitCode = 1
  })
}
