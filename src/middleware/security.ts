import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { bodyLimit } from 'hono/body-limit'
import { getConnInfo } from '@hono/node-server/conninfo'
import type { Config } from '../config.js'
import { ApiError, type AuthService, type UserSession } from '../services/auth.service.js'

export type AppEnv = { Variables: { session: UserSession } }
export type ClientIpProvider = (context: Context<AppEnv>) => string
export function directClientIp(context: Context<AppEnv>): string {
  try { return getConnInfo(context).remote.address ?? 'unknown' } catch { return 'unknown' }
}
export function browserSecurity(config: Config): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const origin = c.req.header('Origin')
    c.header('Vary', 'Origin')
    if (origin !== undefined && origin !== config.frontendOrigin) throw new ApiError(403, 'Origin not allowed')
    if (origin === config.frontendOrigin) {
      c.header('Access-Control-Allow-Origin', origin)
      c.header('Access-Control-Allow-Credentials', 'true')
      c.header('Access-Control-Expose-Headers', 'Retry-After')
    }
    if (c.req.method === 'OPTIONS') {
      c.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
      c.header('Access-Control-Allow-Headers', 'Content-Type')
      return c.body(null, 204)
    }
    await next()
  }
}
export function boundedBody(config: Config): MiddlewareHandler<AppEnv> {
  return bodyLimit({ maxSize: config.httpBodyLimitBytes, onError: () => { throw new ApiError(413, 'Request body too large') } })
}
export function requireAuth(auth: AuthService, config: Config): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const session = auth.authenticate(getCookie(c, config.sessionCookieName) ?? '')
    if (!session) throw new ApiError(401, 'Authentication required')
    c.set('session', session)
    await next()
  }
}
export function authRateLimit(auth: AuthService, clientIp: ClientIpProvider = directClientIp, now?: () => number): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    auth.checkRateLimit('ip', clientIp(c), now?.())
    await next()
  }
}
