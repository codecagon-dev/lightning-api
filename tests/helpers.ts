import type { AuthService } from '../src/services/auth.service.js'

export async function createAndLogin(auth: AuthService, email: string, password: string) {
  await auth.createUser(email, password)
  return auth.login(email, password)
}
