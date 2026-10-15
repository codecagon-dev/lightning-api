import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import type { ReadStream, WriteStream } from 'node:tty'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { config as loadEnvironment } from 'dotenv'
import { loadConfig } from '../config.js'
import { openDatabase } from '../database.js'
import { startupFailure } from '../logging.js'
import { AuthService, ApiError } from '../services/auth.service.js'
import { UserRepository } from '../repositories/user.repository.js'
import { SessionRepository } from '../repositories/session.repository.js'
import { AuthLimitRepository } from '../repositories/auth-limit.repository.js'

const usage = 'Usage: npm run user:create -- <email> (password is prompted securely)'
class CommandError extends Error {}

export async function readPassword(prompt: string, input: ReadStream = process.stdin, output: WriteStream = process.stdout): Promise<string> {
  if (!input.isTTY || !output.isTTY) throw new CommandError('Account creation requires an interactive terminal')
  // Readline manages editing and raw mode; discard its entire echo stream.
  const hidden = new Writable({ write(_chunk, _encoding, done) { done() } })
  const reader = createInterface({ input, output: hidden, terminal: true, historySize: 0 })
  try {
    output.write(prompt)
    return await new Promise<string>((resolveAnswer, reject) => {
      reader.once('SIGINT', () => reject(new CommandError('Account creation cancelled')))
      reader.once('close', () => reject(new CommandError('Account creation cancelled')))
      reader.question('', resolveAnswer)
    })
  } finally {
    reader.close()
    hidden.destroy()
    output.write('\n')
  }
}

export async function createUserCommand(args: string[], env: NodeJS.ProcessEnv, prompt: (label: string) => Promise<string> = readPassword): Promise<void> {
  if (args.length !== 1 || !args[0] || args[0].startsWith('-')) throw new CommandError(usage)
  const config = loadConfig(env)
  if (config.databasePath === ':memory:') throw new CommandError('Account creation requires a persistent DATABASE_PATH')
  const password = await prompt('Password: ')
  const confirmation = await prompt('Confirm password: ')
  if (password !== confirmation) throw new CommandError('Passwords do not match')
  const database = openDatabase(config.databasePath)
  try {
    const auth = new AuthService(new UserRepository(database), new SessionRepository(database), config, new AuthLimitRepository(database))
    await auth.createUser(args[0], password)
  } finally { database.close() }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    process.stdout.write(usage + '\n')
    return
  }
  loadEnvironment({ quiet: true })
  try {
    await createUserCommand(args, process.env)
    process.stdout.write('Account created. You can now log in.\n')
  } catch (error) {
    const message = error instanceof CommandError || error instanceof ApiError ? error.message : startupFailure(error).message
    process.stderr.write(message + '\n')
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main()
