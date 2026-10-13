import type { IpcResult, SpawnedTerminal } from './ipc.types'

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
  /**
   * Sensitive transient credential used only for IPC/backend auth and keychain writes.
   * This field must not be persisted in renderer/local profile stores. While a
   * connection is active, the backend may keep a process-memory copy solely for
   * auto-reconnect; users can avoid that by using SSH agent auth.
   */
  password?: string
  /**
   * Sensitive transient key passphrase used only for IPC/backend auth and
   * keychain writes. This field must not be persisted in renderer/local profile
   * stores. While a connection is active, the backend may keep a process-memory
   * copy solely for auto-reconnect; users can avoid that by using SSH agent auth.
   */
  passphrase?: string
  /** Jump/bastion host profile ID (future use) */
  jumpHostId?: string
  /** Port forwards to auto-start on connect */
  portForwards: PortForwardConfig[]
  /** Tags for organization */
  tags?: string[]
  /** Group the host is listed under in the Hosts view */
  group?: string
  /** Pinned to the Favorites section of the Hosts view */
  favorite?: boolean
  /** Last successful connection timestamp */
  lastConnected?: string
  /** Imported from ~/.ssh/config */
  importedFrom?: string
  /** Whether a password is stored in the OS keychain */
  hasStoredPassword?: boolean
  /** Whether a passphrase is stored in the OS keychain */
  hasStoredPassphrase?: boolean
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
// Interactive sessions (native shell channel adopted as a terminal)
// ============================================================================

/** Connect pipeline step, in order. */
export type SSHSessionStage = 'connecting' | 'verifyingHostKey' | 'authenticating' | 'startingShell'

export interface SSHSessionProgressEvent {
  sessionId: string
  stage: SSHSessionStage
}

/** The server key the user is asked to trust. */
export interface SSHHostKeyPrompt {
  sessionId: string
  /** `unknown`: first connection. `changed`: differs from the trusted key. */
  status: 'unknown' | 'changed'
  host: string
  port: number
  /** OpenSSH key type, e.g. `ssh-ed25519` */
  keyType: string
  /** `SHA256:…`, as printed by `ssh-keygen -lf` */
  fingerprint: string
}

export type SSHSessionEndReason = 'exited' | 'lost' | 'closed'

export interface SSHSessionEndedEvent {
  sessionId: string
  terminalId: string | null
  reason: SSHSessionEndReason
  exitCode: number | null
  detail: string | null
}

export interface SSHSessionInfo {
  sessionId: string
  profileId: string
  terminalId: string | null
  connectedAt: string
}

export interface SSHSessionOpenRequest {
  /** Chosen by the caller so progress events can be matched early. */
  sessionId: string
  profileId: string
  cols: number
  rows: number
  /** Password or key passphrase typed at a prompt. */
  secret?: string
  /** Save `secret` to the OS keychain once it worked. */
  saveSecret?: boolean
}

export interface SSHSessionOpened {
  session: SSHSessionInfo
  terminal: SpawnedTerminal
  secretSaved: boolean
}

export interface SSHLiveSession extends SSHSessionInfo {
  /** Fresh attach credential for the session terminal. */
  claim: string | null
}

export type SSHKeyFileStatus = 'ok' | 'notFound' | 'unreadable' | 'notPrivateKey' | 'puttyFormat'

export interface SSHKeyFileInfo {
  path: string
  status: SSHKeyFileStatus
  /** Protected by a passphrase */
  encrypted: boolean
  keyType: string | null
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

// Legacy connection API, still used by the current SSH panel. Removed once
// the session-based SSH workspace replaces it.
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

export type SSHConnectionStatusCallback = (
  connectionId: string,
  status: SSHConnectionStatus,
  error?: string
) => void

export interface SSHApi {
  // Legacy connection management (see SSHConnection)
  connect: (profileId: string, password?: string) => Promise<IpcResult<SSHConnection>>
  disconnect: (connectionId: string) => Promise<IpcResult<void>>
  getConnections: () => Promise<IpcResult<SSHConnection[]>>
  onConnectionStatusChanged: (callback: SSHConnectionStatusCallback) => () => void

  // Profile management
  listProfiles: () => Promise<IpcResult<SSHProfile[]>>
  saveProfile: (profile: SSHProfile) => Promise<IpcResult<void>>
  deleteProfile: (profileId: string) => Promise<IpcResult<void>>
  importConfig: () => Promise<IpcResult<SSHProfile[]>>

  // Interactive sessions
  openSession: (request: SSHSessionOpenRequest) => Promise<IpcResult<SSHSessionOpened>>
  respondHostKey: (sessionId: string, trust: boolean) => Promise<IpcResult<boolean>>
  cancelSession: (sessionId: string) => Promise<IpcResult<boolean>>
  closeSession: (sessionId: string) => Promise<IpcResult<void>>
  listSessions: () => Promise<IpcResult<SSHLiveSession[]>>
  duplicateProfile: (profileId: string) => Promise<IpcResult<SSHProfile>>
  inspectKey: (path: string) => Promise<IpcResult<SSHKeyFileInfo>>
  listKeys: () => Promise<IpcResult<SSHKeyFileInfo[]>>

  // Port forwarding over a live session's connection (`sessionId` = attempt id)
  startPortForward: (
    sessionId: string,
    config: PortForwardConfig
  ) => Promise<IpcResult<ActivePortForward>>
  stopPortForward: (sessionId: string, forwardId: string) => Promise<IpcResult<void>>

  // SFTP over a live session's connection (`connectionId` = session attempt id)
  sftpListDir: (connectionId: string, remotePath: string) => Promise<IpcResult<SFTPEntry[]>>
  /** Absolute form of a remote path; `.` is the login directory. */
  sftpRealpath: (connectionId: string, remotePath: string) => Promise<IpcResult<string>>
  sftpDownload: (
    connectionId: string,
    remotePath: string,
    localPath: string
  ) => Promise<IpcResult<void>>
  sftpUpload: (
    connectionId: string,
    localPath: string,
    remotePath: string
  ) => Promise<IpcResult<void>>
  sftpDelete: (connectionId: string, remotePath: string) => Promise<IpcResult<void>>
  sftpMkdir: (connectionId: string, remotePath: string) => Promise<IpcResult<void>>
  sftpRename: (connectionId: string, oldPath: string, newPath: string) => Promise<IpcResult<void>>
  sftpReadFile: (connectionId: string, remotePath: string) => Promise<IpcResult<string>>
  sftpWriteFile: (
    connectionId: string,
    remotePath: string,
    content: string
  ) => Promise<IpcResult<void>>
  sftpCreateFile: (connectionId: string, remotePath: string) => Promise<IpcResult<void>>

  // Event listeners
  onPortForwardStatusChanged: (callback: PortForwardStatusCallback) => () => void
  onTransferProgress: (callback: TransferProgressCallback) => () => void
  onSessionProgress: (callback: (event: SSHSessionProgressEvent) => void) => () => void
  onSessionHostKey: (callback: (prompt: SSHHostKeyPrompt) => void) => () => void
  onSessionEnded: (callback: (event: SSHSessionEndedEvent) => void) => () => void
}

// Event callback types
export type PortForwardStatusCallback = (connectionId: string, forward: ActivePortForward) => void
export type TransferProgressCallback = (progress: SFTPTransferProgress) => void
