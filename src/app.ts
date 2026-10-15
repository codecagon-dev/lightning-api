import { Hono } from 'hono'
import { matchedRoutes } from 'hono/route'
import { defaultLogger, log, type Logger } from './logging.js'
import type { Config } from './config.js'
import { ApiError, type AuthService } from './services/auth.service.js'
import { boundedBody, browserSecurity, type AppEnv, type ClientIpProvider } from './middleware/security.js'
import { authRoutes } from './routes/auth.js'

export interface AppDependencies {
  logger?: Logger
  config: Config
  authService: AuthService
  clientIp?: ClientIpProvider
  now?: () => number
  registerRoutes?: (app: Hono<AppEnv>) => void
}
export function createApp(deps: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const logger = deps.logger ?? defaultLogger
  app.onError((error, c) => {
    if (error instanceof ApiError) return c.json({ error: error.message }, error.status)
    log(logger, 'error', { event: 'internal_error', reason: 'unexpected_error' })
    return c.json({ error: 'Internal server error' }, 500)
  })
  app.use('*', async (c, next) => {
    const start = performance.now()
    await next()
    const route = matchedRoutes(c).find(route => route.method === c.req.method ||
      (c.req.method === 'HEAD' && route.method === 'GET'))?.path ?? '<unmatched>'
    const statusCode = c.res.status
    log(logger, statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info', {
      event: 'http_request', method: c.req.method, route, statusCode,
      durationMs: Math.max(0, performance.now() - start),
    })
  })
  app.notFound(c => c.json({ error: 'Not found' }, 404))
  app.use('*', browserSecurity(deps.config), boundedBody(deps.config))
  app.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next() })
  app.route('/auth', authRoutes(deps.authService, deps.config, deps.clientIp, deps.now))
  deps.registerRoutes?.(app)
  return app
}
