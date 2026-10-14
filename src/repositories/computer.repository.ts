import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Computer, ComputerStatus, Credentials, PublicComputer } from '../types.js'

export type ComputerInput = Omit<Computer, 'id' | 'ownerId' | 'encryptedCredentials' | 'createdAt'> & Credentials
export type CredentialEncryptor = (computerId: string, ownerId: string, credentials: Credentials) => string
const columns = `id, owner_id AS ownerId, name, os, ip_address AS ipAddress,
  mac_address AS macAddress, broadcast_address AS broadcastAddress,
  ssh_port AS sshPort, wol_port AS wolPort, ssh_username AS sshUsername,
  ssh_host_key_fingerprint AS sshHostKeyFingerprint,
  encrypted_credentials AS encryptedCredentials, created_at AS createdAt`

export class ComputerRepository {
  constructor(private readonly database: DatabaseSync, private readonly encrypt: CredentialEncryptor) {}

  create(ownerId: string, input: ComputerInput): Computer {
    const id = randomUUID()
    const credentials: Credentials = input.sshPassword !== undefined
      ? { sshPassword: input.sshPassword }
      : { sshPrivateKey: input.sshPrivateKey!, ...(input.sshPrivateKeyPassphrase !== undefined ? { sshPrivateKeyPassphrase: input.sshPrivateKeyPassphrase } : {}) }
    const computer: Computer = {
      id, ownerId, name: input.name, os: input.os, ipAddress: input.ipAddress,
      macAddress: input.macAddress, broadcastAddress: input.broadcastAddress,
      sshPort: input.sshPort, wolPort: input.wolPort, sshUsername: input.sshUsername,
      sshHostKeyFingerprint: input.sshHostKeyFingerprint,
      encryptedCredentials: this.encrypt(id, ownerId, credentials), createdAt: new Date().toISOString(),
    }
    this.database.prepare(`INSERT INTO computers
      (id, owner_id, name, os, ip_address, mac_address, broadcast_address, ssh_port, wol_port,
       ssh_username, ssh_host_key_fingerprint, encrypted_credentials, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(computer.id, computer.ownerId, computer.name, computer.os, computer.ipAddress,
        computer.macAddress, computer.broadcastAddress, computer.sshPort, computer.wolPort,
        computer.sshUsername, computer.sshHostKeyFingerprint, computer.encryptedCredentials, computer.createdAt)
    return computer
  }

  findOwned(ownerId: string, id: string): Computer | null {
    return this.database.prepare(`SELECT ${columns} FROM computers WHERE owner_id = ? AND id = ?`).get(ownerId, id) as unknown as Computer ?? null
  }

  listOwned(ownerId: string): Computer[] {
    return this.database.prepare(`SELECT ${columns} FROM computers WHERE owner_id = ? ORDER BY created_at, id`).all(ownerId) as unknown as Computer[]
  }

  listAll(): Computer[] {
    return this.database.prepare(`SELECT ${columns} FROM computers ORDER BY created_at, id`).all() as unknown as Computer[]
  }
}

export function toPublicComputer(computer: Computer, status: ComputerStatus): PublicComputer {
  // Select fields explicitly: new internal fields never become public by default.
  return {
    id: computer.id, name: computer.name, os: computer.os, ipAddress: computer.ipAddress,
    macAddress: computer.macAddress, broadcastAddress: computer.broadcastAddress,
    sshPort: computer.sshPort, wolPort: computer.wolPort, sshUsername: computer.sshUsername,
    sshHostKeyFingerprint: computer.sshHostKeyFingerprint, createdAt: computer.createdAt,
    status: status.status, checkedAt: status.checkedAt,
  }
}
