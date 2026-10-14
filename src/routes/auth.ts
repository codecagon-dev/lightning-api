import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Config } from '../config.js'
import { ApiError, type AuthService } from '../services/auth.service.js'
import { authRateLimit, requireAuth, type AppEnv, type ClientIpProvider } from '../middleware/security.js'

export function authRoutes(auth: AuthService, config: Config, clientIp?: ClientIpProvider, now?: () => number): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()
  const limit = authRateLimit(clientIp, now)
  const cookieOptions = { httpOnly: true, secure: config.secureCookies, sameSite: 'Strict' as const, path: '/' }
  for (const action of ['register', 'login'] as const) {
    routes.post(`/${action}`, limit, async c => {
      if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) throw new ApiError(415, 'JSON body required')
      let body: unknown
      try { body = await c.req.json() } catch { throw new ApiError(400, 'Invalid JSON body') }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'email,password') throw new ApiError(400, 'Invalid request fields')
      const { email, password } = body as Record<string, unknown>
      if (typeof email !== 'string' || typeof password !== 'string') throw new ApiError(400, 'Invalid request fields')
      const { user, token } = await auth[action](email, password)
      setCookie(c, config.sessionCookieName, token, { ...cookieOptions, maxAge: config.sessionLifetimeMs / 1000 })
      return c.json({ user: { id: user.id, email: user.email } }, action === 'register' ? 201 : 200)
    })
  }
  routes.post('/logout', c => {
    auth.logout(getCookie(c, config.sessionCookieName) ?? '')
    deleteCookie(c, config.sessionCookieName, cookieOptions)
    return c.body(null, 204)
  })
  routes.get('/me', requireAuth(auth, config), c => {
    const user = auth.getUser(c.get('session').userId)
    if (!user) throw new ApiError(401, 'Authentication required')
    return c.json({ user: { id: user.id, email: user.email } })
  })
  return routes
}
