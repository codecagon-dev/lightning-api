import { Hono } from 'hono'
import type { Config } from './config.js'
import { ApiError, type AuthService } from './services/auth.service.js'
import { boundedBody, browserSecurity, type AppEnv, type ClientIpProvider } from './middleware/security.js'
import { authRoutes } from './routes/auth.js'

export interface AppDependencies {
  config: Config
  authService: AuthService
  clientIp?: ClientIpProvider
  now?: () => number
  registerRoutes?: (app: Hono<AppEnv>) => void
}
export function createApp(deps: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.onError((error, c) => error instanceof ApiError
    ? c.json({ error: error.message }, error.status)
    : c.json({ error: 'Internal server error' }, 500))
  app.notFound(c => c.json({ error: 'Not found' }, 404))
  app.use('*', browserSecurity(deps.config), boundedBody(deps.config))
  app.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next() })
  app.route('/auth', authRoutes(deps.authService, deps.config, deps.clientIp, deps.now))
  deps.registerRoutes?.(app)
  return app
}
