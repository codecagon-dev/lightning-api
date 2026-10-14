export interface Config {
  mode: 'development' | 'production'
  host: string
  port: number
  databasePath: string
  frontendOrigin: string
  credentialEncryptionKey: Buffer
  secureCookies: boolean
  sessionCookieName: string
  sessionLifetimeMs: number
  httpBodyLimitBytes: number
  credentialLimitBytes: number
  sshConnectTimeoutMs: number
  sshCommandTimeoutMs: number
  tcpProbeTimeoutMs: number
  pollIntervalMs: number
  maxConcurrentProbes: number
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const mode = env.NODE_ENV ?? 'production'
  if (mode !== 'development' && mode !== 'production') throw new Error('NODE_ENV must be development or production')
  const encodedKey = env.CREDENTIAL_ENCRYPTION_KEY
  if (!encodedKey || !/^[A-Za-z0-9+/]{43}=$/.test(encodedKey)) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key')
  }
  const credentialEncryptionKey = Buffer.from(encodedKey, 'base64')
  if (credentialEncryptionKey.length !== 32 || credentialEncryptionKey.toString('base64') !== encodedKey) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key')
  }
  const frontendOrigin = env.FRONTEND_ORIGIN ?? (mode === 'development' ? 'http://localhost:5173' : '')
  let origin: URL
  try { origin = new URL(frontendOrigin) } catch { throw new Error('FRONTEND_ORIGIN must be an exact origin') }
  if (origin.origin !== frontendOrigin || !['http:', 'https:'].includes(origin.protocol) || (mode === 'production' && origin.protocol !== 'https:')) {
    throw new Error('FRONTEND_ORIGIN must be an exact HTTPS origin in production')
  }
  const rawPort = env.PORT ?? '3000'
  const port = Number(rawPort)
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535')
  const host = env.HOST ?? '127.0.0.1'
  const databasePath = env.DATABASE_PATH ?? './data/lightning.sqlite'
  if (!host || !databasePath) throw new Error('HOST and DATABASE_PATH must be nonempty')
  return {
    mode, host, port, databasePath, frontendOrigin, credentialEncryptionKey,
    secureCookies: mode === 'production',
    sessionCookieName: 'lightning_session',
    sessionLifetimeMs: 7 * 24 * 60 * 60 * 1000,
    httpBodyLimitBytes: 64 * 1024,
    credentialLimitBytes: 32 * 1024,
    sshConnectTimeoutMs: 10_000,
    sshCommandTimeoutMs: 10_000,
    tcpProbeTimeoutMs: 2_000,
    pollIntervalMs: 10_000,
    maxConcurrentProbes: 10,
  }
}
