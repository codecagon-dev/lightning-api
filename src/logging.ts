import type { SshStatus } from './types.js'
export type PowerReason = 'unknown' | 'hostkey_mismatch' | 'auth_failed' | 'connect_failed' | 'connect_timeout' | 'command_timeout' | 'command_failed' | 'udp_failed' | 'udp_timeout' | 'credential_decryption'
export const powerReasons: readonly PowerReason[] = ['unknown', 'hostkey_mismatch', 'auth_failed', 'connect_failed', 'connect_timeout', 'command_timeout', 'command_failed', 'udp_failed', 'udp_timeout', 'credential_decryption']
type Level = 'info' | 'warn' | 'error'
export type LogEvent =
  | { event: 'ssh_check'; computerId: string; outcome: Exclude<SshStatus, 'unknown'> }
  | { event: 'http_request'; method: string; route: string; statusCode: number; durationMs: number }
  | { event: 'internal_error'; reason: 'unexpected_error' }
  | { event: 'power_action'; action: 'on' | 'off'; computerId: string; outcome: 'success' | 'failure'; reason?: PowerReason }
  | { event: 'startup' | 'shutdown_started' | 'shutdown_complete' }
  | { event: 'startup_failed'; reason: string; message: string }
  | { event: 'shutdown_failed'; reason: 'shutdown_error' }
export interface Logger { log(level: Level, event: LogEvent): void }
// A writable can report EPIPE asynchronously after write() returns. Install one
// persistent handler per default stream and stop writing after its first failure.
const guardedStreams = new WeakSet<NodeJS.WriteStream>()
const failedStreams = new WeakSet<NodeJS.WriteStream>()
function writeDefault(level: Level, line: string): void {
  const stream = level === 'info' ? process.stdout : process.stderr
  if (!guardedStreams.has(stream)) {
    guardedStreams.add(stream)
    stream.on('error', () => { failedStreams.add(stream) })
  }
  if (!failedStreams.has(stream)) stream.write(line + '\n')
}
export function createLogger(sink?: (line: string) => void): Logger {
  return { log(level, event) {
    try {
      const line = JSON.stringify({ timestamp: new Date().toISOString(), level, ...event })
      if (sink) sink(line)
      else writeDefault(level, line)
    } catch { /* Diagnostics must never change application behavior. */ }
  } }
}
export const defaultLogger = createLogger()
export function log(logger: Logger, level: Level, event: LogEvent): void {
  try { logger.log(level, event) } catch { /* Also contain failures from injected loggers. */ }
}
const configurationMessages = new Set([
  'NODE_ENV must be development or production',
  'CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key',
  'FRONTEND_ORIGIN must be an exact origin',
  'FRONTEND_ORIGIN must be an exact HTTPS origin in production',
  'PORT must be an integer between 1 and 65535',
  'HOST and DATABASE_PATH must be nonempty',
])
const startupCodes: Record<string, string> = {
  EADDRINUSE: 'Listening address is already in use; check HOST and PORT',
  EACCES: 'Permission denied; check listening address and database permissions',
  EADDRNOTAVAIL: 'Listening address is unavailable; check HOST',
  SQLITE_CANTOPEN: 'Cannot open database; check DATABASE_PATH and directory permissions',
  SQLITE_READONLY: 'Database is read-only; check database permissions',
  SQLITE_BUSY: 'Database is busy; check other database processes',
  SQLITE_CORRUPT: 'Database is corrupt; restore a verified backup',
}
export function startupFailure(error: unknown): { reason: string; message: string } {
  if (error instanceof Error && configurationMessages.has(error.message)) return { reason: 'configuration', message: error.message }
  let code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (code === 'ERR_SQLITE_ERROR' && error && typeof error === 'object' && 'errcode' in error && typeof error.errcode === 'number') {
    const sqliteCodes: Record<number, string> = { 5: 'SQLITE_BUSY', 8: 'SQLITE_READONLY', 11: 'SQLITE_CORRUPT', 14: 'SQLITE_CANTOPEN' }
    code = sqliteCodes[error.errcode & 255]
  }
  if (typeof code === 'string' && Object.hasOwn(startupCodes, code)) return { reason: code, message: startupCodes[code]! }
  return { reason: 'unknown', message: 'Startup failed; check configuration and database availability' }
}
