export type Credentials =
  | { sshPassword: string; sshPrivateKey?: never; sshPrivateKeyPassphrase?: never }
  | { sshPassword?: never; sshPrivateKey: string; sshPrivateKeyPassphrase?: string }

export type Status = 'unknown' | 'online' | 'offline'

export type SshStatus = 'unknown' | 'ready' | 'auth_failed' | 'host_key_mismatch' | 'unreachable' | 'error'

export interface ComputerStatus {
  status: Status
  checkedAt: string | null
  sshStatus: SshStatus
  sshCheckedAt: string | null
}

export interface Computer {
  id: string
  ownerId: string
  name: string
  color: string | null
  os: 'linux' | 'windows'
  ipAddress: string
  macAddress: string
  broadcastAddress: string
  sshPort: number
  wolPort: number
  sshUsername: string
  sshHostKeyFingerprint: string
  encryptedCredentials: string
  createdAt: string
}

export type PublicComputer = Omit<Computer, 'ownerId' | 'encryptedCredentials'> & ComputerStatus

export interface User {
  id: string
  email: string
  passwordHash: string
  createdAt: string
}

export interface Session {
  tokenHash: string
  userId: string
  expiresAt: number
}
