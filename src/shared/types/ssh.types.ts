import type { IpcResult } from './ipc.types'

// ============================================================================
// SSH Profile & Connection Types
// ============================================================================

export type SSHAuthMethod = 'password' | 'key' | 'agent'

export interface SSHProfile {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod: SSHAuthMethod
  privateKeyPath?: string
  /** Stored password (for password auth) */
  password?: string
  /** Passphrase for private key */
  passphrase?: string
  /** Jump/bastion host profile ID (future use) */
  jumpHostId?: string
  /** Port forwards to auto-start on connect */
  portForwards: PortForwardConfig[]
  /** Tags for organization */
  tags?: string[]
  /** Last successful connection timestamp */
  lastConnected?: string
  /** Imported from ~/.ssh/config */
  importedFrom?: string
}

export interface PortForwardConfig {
  id: string
  type: 'local' | 'remote'
  localPort: number
  remoteHost: string
  remotePort: number
  label?: string
  autoStart: boolean
}

export type SSHConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'

export interface SSHConnection {
  id: string
  profileId: string
  status: SSHConnectionStatus
  /** PTY terminal ID for the interactive shell */
  terminalId?: string
  /** Active port forwards */
  activeForwards: ActivePortForward[]
  /** Error message if status is 'failed' */
  error?: string
  /** Number of reconnect attempts */
  reconnectAttempts: number
  /** Timestamp of connection start */
  connectedAt?: string
}

export interface ActivePortForward {
  id: string
  configId: string
  localPort: number
  remoteHost: string
  remotePort: number
  type: 'local' | 'remote'
  status: 'active' | 'failed' | 'stopped'
  error?: string
}

// ============================================================================
// SFTP Types
// ============================================================================

export type SFTPEntryType = 'file' | 'directory' | 'symlink'

export interface SFTPEntry {
  name: string
  path: string
  entryType: SFTPEntryType
  size: number
  /** Unix permissions (e.g., 0o755) */
  permissions: number
  /** Modified time as ISO string */
  modifiedAt: string
  /** Owner user (if available) */
  owner?: string
}

export interface SFTPTransferProgress {
  connectionId: string
  remotePath: string
  localPath: string
  bytesTransferred: number
  totalBytes: number
  /** 'upload' | 'download' */
  direction: 'upload' | 'download'
  status: 'in-progress' | 'completed' | 'failed' | 'cancelled'
  error?: string
}

// ============================================================================
// SSH IPC API Interface
// ============================================================================

export interface SSHApi {
  // Profile management
  listProfiles: () => Promise<IpcResult<SSHProfile[]>>
  saveProfile: (profile: SSHProfile) => Promise<IpcResult<void>>
  deleteProfile: (profileId: string) => Promise<IpcResult<void>>
  importConfig: () => Promise<IpcResult<SSHProfile[]>>

  // Connection management
  connect: (profileId: string, password?: string) => Promise<IpcResult<SSHConnection>>
  disconnect: (connectionId: string) => Promise<IpcResult<void>>
  getConnections: () => Promise<IpcResult<SSHConnection[]>>

  // Port forwarding
  startPortForward: (connectionId: string, config: PortForwardConfig) => Promise<IpcResult<ActivePortForward>>
  stopPortForward: (connectionId: string, forwardId: string) => Promise<IpcResult<void>>

  // SFTP operations
  sftpListDir: (connectionId: string, remotePath: string) => Promise<IpcResult<SFTPEntry[]>>
  sftpDownload: (connectionId: string, remotePath: string, localPath: string) => Promise<IpcResult<void>>
  sftpUpload: (connectionId: string, localPath: string, remotePath: string) => Promise<IpcResult<void>>
  sftpDelete: (connectionId: string, remotePath: string) => Promise<IpcResult<void>>
  sftpMkdir: (connectionId: string, remotePath: string) => Promise<IpcResult<void>>
  sftpRename: (connectionId: string, oldPath: string, newPath: string) => Promise<IpcResult<void>>
  sftpReadFile: (connectionId: string, remotePath: string) => Promise<IpcResult<string>>
  sftpWriteFile: (connectionId: string, remotePath: string, content: string) => Promise<IpcResult<void>>
  sftpCreateFile: (connectionId: string, remotePath: string) => Promise<IpcResult<void>>

  // Event listeners
  onConnectionStatusChanged: (callback: SSHConnectionStatusCallback) => () => void
  onPortForwardStatusChanged: (callback: PortForwardStatusCallback) => () => void
  onTransferProgress: (callback: TransferProgressCallback) => () => void
}

// Event callback types
export type SSHConnectionStatusCallback = (connectionId: string, status: SSHConnectionStatus, error?: string) => void
export type PortForwardStatusCallback = (connectionId: string, forward: ActivePortForward) => void
export type TransferProgressCallback = (progress: SFTPTransferProgress) => void
