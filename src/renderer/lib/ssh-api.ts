import type { IpcResult } from '@shared/types/ipc.types'
import { PersistenceKeys } from '@shared/types/persistence.types'
import type {
  ActivePortForward,
  PortForwardConfig,
  PortForwardStatusCallback,
  SFTPEntry,
  SFTPTransferProgress,
  SSHApi,
  SSHHostKeyPrompt,
  SSHKeyFileInfo,
  SSHLiveSession,
  SSHProfile,
  SSHSessionEndedEvent,
  SSHSessionOpened,
  SSHSessionOpenRequest,
  SSHSessionProgressEvent,
  TransferProgressCallback
} from '@shared/types/ssh.types'
import type { SshWsRequestType } from '@shared/types/web-protocol.types'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getAcpTransport } from './acp-transport'
import type { AcpTransport } from './acp-transport/types'
import { invokeIpc as invokeTauriIpc } from './ipc/tauri'
import { persistenceApi } from './persistence-api'
import { cleanupTauriListener, isTauriContext } from './tauri-runtime'

/** How many times a profile list rewrite is tried before a lost compare-and-set race ends it. */
const PROFILE_WRITE_ATTEMPTS = 5

/**
 * Web mode has no OS keychain — persist profile metadata without secrets,
 * mirroring the desktop store (which never writes password/passphrase to disk
 * and only records that a keychain credential exists).
 */
function toStoredProfile(profile: SSHProfile): SSHProfile {
  const { password: _password, passphrase: _passphrase, ...rest } = profile
  return { ...rest, hasStoredPassword: false, hasStoredPassphrase: false }
}

/** Read web profiles from the server-side store; first run = empty list. */
async function readProfilesFromStore(): Promise<IpcResult<SSHProfile[]>> {
  const result = await readProfilesSnapshot()
  return result.success ? { success: true, data: result.data.profiles } : result
}

/**
 * The profile list plus the CAS precondition for rewriting it: the list the
 * host holds, or `null` when the key does not exist yet (first run) so the
 * first write asserts "key must be absent".
 */
async function readProfilesSnapshot(): Promise<
  IpcResult<{ profiles: SSHProfile[]; expected: SSHProfile[] | null }>
> {
  const result = await persistenceApi.read<SSHProfile[]>(PersistenceKeys.sshProfiles)
  if (result.success) {
    return { success: true, data: { profiles: result.data, expected: result.data } }
  }
  if (result.code === 'KEY_NOT_FOUND') {
    return { success: true, data: { profiles: [], expected: null } }
  }
  return result
}

const SSH_EVENTS = {
  PORT_FORWARD_STATUS_CHANGED: 'ssh-port-forward-status-changed',
  TRANSFER_PROGRESS: 'ssh-transfer-progress',
  SESSION_PROGRESS: 'ssh-session-progress',
  SESSION_HOST_KEY: 'ssh-session-host-key',
  SESSION_ENDED: 'ssh-session-ended'
} as const

const SSH_COMMANDS = {
  LIST_PROFILES: 'ssh_list_profiles',
  SAVE_PROFILE: 'ssh_save_profile',
  DELETE_PROFILE: 'ssh_delete_profile',
  IMPORT_CONFIG: 'ssh_import_config',
  PORT_FORWARD_START: 'ssh_port_forward_start',
  PORT_FORWARD_STOP: 'ssh_port_forward_stop',
  SFTP_LIST_DIR: 'sftp_list_dir',
  SFTP_REALPATH: 'sftp_realpath',
  SFTP_DOWNLOAD: 'sftp_download',
  SFTP_UPLOAD: 'sftp_upload',
  SFTP_DELETE: 'sftp_delete',
  SFTP_MKDIR: 'sftp_mkdir',
  SFTP_RENAME: 'sftp_rename',
  SFTP_READ_FILE: 'sftp_read_file',
  SFTP_WRITE_FILE: 'sftp_write_file',
  SFTP_CREATE_FILE: 'sftp_create_file',
  SESSION_OPEN: 'ssh_session_open',
  SESSION_RESPOND_HOST_KEY: 'ssh_session_respond_host_key',
  SESSION_CANCEL: 'ssh_session_cancel',
  SESSION_CLOSE: 'ssh_session_close',
  SESSION_LIST: 'ssh_session_list',
  DUPLICATE_PROFILE: 'ssh_duplicate_profile',
  INSPECT_KEY: 'ssh_inspect_key',
  LIST_KEYS: 'ssh_list_keys'
} as const satisfies Record<string, SshCommand>

/** The SSH commands; port forwarding stays desktop-only (no renderer caller). */
type SshCommand = SshWsRequestType | 'ssh_port_forward_start' | 'ssh_port_forward_stop'

const WEB_UNSUPPORTED = {
  success: false,
  error: 'SSH is not available in the web client',
  code: 'WEB_UNSUPPORTED'
} as const

/**
 * The web transport when the host runs SSH for this connection: only a
 * `hostLocal` one (a client on the host itself holding the server token,
 * such as the GPUIX desktop client). The grant is known after the
 * handshake, so a call made before it waits for the connection.
 */
async function hostTransport(): Promise<AcpTransport | null> {
  const transport = getAcpTransport()
  if (!transport.sshRequest || !transport.connectionCapabilities) return null
  if (transport.connectionCapabilities() === null) {
    try {
      await transport.connect()
    } catch {
      return null
    }
  }
  return transport.connectionCapabilities()?.hostLocal === true ? transport : null
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'SSH_INTERNAL'
}

/**
 * Desktop: the Tauri command. Web: the same command over `/ws` when the host
 * runs SSH for this connection, else an explicit `WEB_UNSUPPORTED` result
 * (never the stubbed Tauri `invoke`, which throws on web). Every SSH command
 * method delegates through here.
 */
async function invokeIpc<T>(
  command: SshCommand,
  args?: Record<string, unknown>
): Promise<IpcResult<T>> {
  if (isTauriContext()) return invokeTauriIpc<T>(command, args)
  if (command === 'ssh_port_forward_start' || command === 'ssh_port_forward_stop') {
    return WEB_UNSUPPORTED
  }
  const transport = await hostTransport()
  if (!transport?.sshRequest) return WEB_UNSUPPORTED
  try {
    return { success: true, data: await transport.sshRequest<T>(command, args) }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      code: errorCode(error)
    }
  }
}

/**
 * Whether this surface can run SSH sessions now: the desktop, or a web
 * connection whose handshake granted `hostLocal`. For UI gates that render
 * synchronously; `false` until that handshake.
 */
export function canUseHostSsh(): boolean {
  if (isTauriContext()) return true
  const transport = getAcpTransport()
  return !!transport.sshRequest && transport.connectionCapabilities?.()?.hostLocal === true
}

/** Whether profiles live with the host's SSH (desktop, host-local web). */
async function hostOwnsProfiles(): Promise<boolean> {
  return isTauriContext() || (await hostTransport()) !== null
}

interface SshWatchDelta {
  event?: string
  payload?: unknown
}

/**
 * Subscribe to one SSH event: a Tauri event on desktop, a delta of the host's
 * `ssh` watch on a host-local web connection, a no-op otherwise.
 */
function listenSsh<T>(event: string, callback: (payload: T) => void): () => void {
  if (isTauriContext()) return listenDesktop(event, callback)
  let stopped = false
  let stop: (() => void) | undefined
  void hostTransport().then((transport) => {
    if (stopped || !transport?.watches) return
    stop = transport.watches.subscribe<unknown, SshWatchDelta>('ssh', {
      onState: () => {},
      onDelta: (delta) => {
        if (delta?.event === event) callback(delta.payload as T)
      }
    })
  })
  return () => {
    stopped = true
    stop?.()
  }
}

/** Subscribe to a Tauri event. */
function listenDesktop<T>(event: string, callback: (payload: T) => void): () => void {
  let unlisten: Promise<UnlistenFn> | undefined
  try {
    unlisten = listen<T>(event, ({ payload }) => callback(payload))
  } catch {
    return () => {}
  }
  return () => {
    cleanupTauriListener(unlisten)
  }
}

export function createSSHApi(): SSHApi {
  return {
    // Profiles live with the host's SSH on desktop and on a host-local web
    // connection; any other web client keeps them in the server-side store
    // (it cannot open sessions).
    async listProfiles(): Promise<IpcResult<SSHProfile[]>> {
      if (!(await hostOwnsProfiles())) return readProfilesFromStore()
      return invokeIpc<SSHProfile[]>(SSH_COMMANDS.LIST_PROFILES)
    },

    async saveProfile(profile: SSHProfile): Promise<IpcResult<void>> {
      if (!(await hostOwnsProfiles())) {
        for (let attempt = 0; attempt < PROFILE_WRITE_ATTEMPTS; attempt++) {
          const list = await readProfilesSnapshot()
          if (!list.success) return list
          const updated = list.data.profiles.filter((p) => p.id !== profile.id)
          updated.push(toStoredProfile(profile))

          // `ssh/profiles` is a shared/cas key: the write is only accepted while
          // the host still holds `expected` (null = key absent). The facade
          // journals the commandId, so a resend of this exact write reuses it.
          const res = await persistenceApi.write(PersistenceKeys.sshProfiles, updated, {
            expected: list.data.expected,
            // Only the last lost race is reported to the user.
            retrying: attempt < PROFILE_WRITE_ATTEMPTS - 1
          })
          if (res.success || res.code !== 'STORE_CAS_FAILED') return res
        }
        return { success: false, error: 'Concurrent modification failed', code: 'STORE_CAS_FAILED' }
      }
      return invokeIpc<void>(SSH_COMMANDS.SAVE_PROFILE, { profile })
    },

    async deleteProfile(profileId: string): Promise<IpcResult<void>> {
      if (!(await hostOwnsProfiles())) {
        for (let attempt = 0; attempt < PROFILE_WRITE_ATTEMPTS; attempt++) {
          const list = await readProfilesSnapshot()
          if (!list.success) return list
          const updated = list.data.profiles.filter((p) => p.id !== profileId)
          if (updated.length === list.data.profiles.length)
            return { success: true, data: undefined }

          const res = await persistenceApi.write(PersistenceKeys.sshProfiles, updated, {
            expected: list.data.expected,
            // Only the last lost race is reported to the user.
            retrying: attempt < PROFILE_WRITE_ATTEMPTS - 1
          })
          if (res.success || res.code !== 'STORE_CAS_FAILED') return res
        }
        return { success: false, error: 'Concurrent modification failed', code: 'STORE_CAS_FAILED' }
      }
      return invokeIpc<void>(SSH_COMMANDS.DELETE_PROFILE, { profileId })
    },

    async importConfig(): Promise<IpcResult<SSHProfile[]>> {
      return invokeIpc<SSHProfile[]>(SSH_COMMANDS.IMPORT_CONFIG)
    },

    // Port forwarding
    async startPortForward(
      sessionId: string,
      config: PortForwardConfig
    ): Promise<IpcResult<ActivePortForward>> {
      return invokeIpc<ActivePortForward>(SSH_COMMANDS.PORT_FORWARD_START, {
        request: {
          connectionId: sessionId,
          id: config.id,
          forwardType: config.type,
          localPort: config.localPort,
          remoteHost: config.remoteHost,
          remotePort: config.remotePort,
          label: config.label
        }
      })
    },

    async stopPortForward(sessionId: string, forwardId: string): Promise<IpcResult<void>> {
      return invokeIpc<void>(SSH_COMMANDS.PORT_FORWARD_STOP, {
        connectionId: sessionId,
        forwardId
      })
    },

    // SFTP operations
    async sftpListDir(connectionId: string, remotePath: string): Promise<IpcResult<SFTPEntry[]>> {
      return invokeIpc<SFTPEntry[]>(SSH_COMMANDS.SFTP_LIST_DIR, {
        request: { connectionId, remotePath }
      })
    },

    async sftpRealpath(connectionId: string, remotePath: string): Promise<IpcResult<string>> {
      return invokeIpc<string>(SSH_COMMANDS.SFTP_REALPATH, {
        request: { connectionId, remotePath }
      })
    },

    async sftpDownload(
      connectionId: string,
      remotePath: string,
      localPath: string
    ): Promise<IpcResult<void>> {
      return invokeIpc<void>(SSH_COMMANDS.SFTP_DOWNLOAD, {
        request: { connectionId, remotePath, localPath }
      })
    },

    async sftpUpload(
      connectionId: string,
      localPath: string,
      remotePath: string
    ): Promise<IpcResult<void>> {
      return invokeIpc<void>(SSH_COMMANDS.SFTP_UPLOAD, {
        request: { connectionId, remotePath, localPath }
      })
    },

    async sftpDelete(connectionId: string, remotePath: string): Promise<IpcResult<void>> {
      return invokeIpc<void>(SSH_COMMANDS.SFTP_DELETE, {
        request: { connectionId, remotePath }
      })
    },

    async sftpMkdir(connectionId: string, remotePath: string): Promise<IpcResult<void>> {
      return invokeIpc<void>(SSH_COMMANDS.SFTP_MKDIR, {
        request: { connectionId, remotePath }
      })
    },

    async sftpRename(
      connectionId: string,
      oldPath: string,
      newPath: string
    ): Promise<IpcResult<void>> {
      return invokeIpc<void>(SSH_COMMANDS.SFTP_RENAME, {
        request: { connectionId, oldPath, newPath }
      })
    },

    async sftpReadFile(connectionId: string, remotePath: string): Promise<IpcResult<string>> {
      return invokeIpc<string>(SSH_COMMANDS.SFTP_READ_FILE, {
        request: { connectionId, remotePath }
      })
    },

    async sftpWriteFile(
      connectionId: string,
      remotePath: string,
      content: string
    ): Promise<IpcResult<void>> {
      return invokeIpc<void>(SSH_COMMANDS.SFTP_WRITE_FILE, {
        request: { connectionId, remotePath, content }
      })
    },

    async sftpCreateFile(connectionId: string, remotePath: string): Promise<IpcResult<void>> {
      return invokeIpc<void>(SSH_COMMANDS.SFTP_CREATE_FILE, {
        request: { connectionId, remotePath }
      })
    },

    // Interactive sessions
    async openSession(request: SSHSessionOpenRequest): Promise<IpcResult<SSHSessionOpened>> {
      return invokeIpc<SSHSessionOpened>(SSH_COMMANDS.SESSION_OPEN, { request })
    },

    async respondHostKey(sessionId: string, trust: boolean): Promise<IpcResult<boolean>> {
      return invokeIpc<boolean>(SSH_COMMANDS.SESSION_RESPOND_HOST_KEY, { sessionId, trust })
    },

    async cancelSession(sessionId: string): Promise<IpcResult<boolean>> {
      return invokeIpc<boolean>(SSH_COMMANDS.SESSION_CANCEL, { sessionId })
    },

    async closeSession(sessionId: string): Promise<IpcResult<void>> {
      return invokeIpc<void>(SSH_COMMANDS.SESSION_CLOSE, { sessionId })
    },

    async listSessions(): Promise<IpcResult<SSHLiveSession[]>> {
      return invokeIpc<SSHLiveSession[]>(SSH_COMMANDS.SESSION_LIST)
    },

    async duplicateProfile(profileId: string): Promise<IpcResult<SSHProfile>> {
      return invokeIpc<SSHProfile>(SSH_COMMANDS.DUPLICATE_PROFILE, { profileId })
    },

    async inspectKey(path: string): Promise<IpcResult<SSHKeyFileInfo>> {
      return invokeIpc<SSHKeyFileInfo>(SSH_COMMANDS.INSPECT_KEY, { path })
    },

    async listKeys(): Promise<IpcResult<SSHKeyFileInfo[]>> {
      return invokeIpc<SSHKeyFileInfo[]>(SSH_COMMANDS.LIST_KEYS)
    },

    // Event listeners
    onPortForwardStatusChanged(callback: PortForwardStatusCallback): () => void {
      return listenSsh<[string, ActivePortForward]>(
        SSH_EVENTS.PORT_FORWARD_STATUS_CHANGED,
        (payload) => callback(payload[0], payload[1])
      )
    },

    onTransferProgress(callback: TransferProgressCallback): () => void {
      return listenSsh<SFTPTransferProgress>(SSH_EVENTS.TRANSFER_PROGRESS, callback)
    },

    onSessionProgress(callback: (event: SSHSessionProgressEvent) => void): () => void {
      return listenSsh<SSHSessionProgressEvent>(SSH_EVENTS.SESSION_PROGRESS, callback)
    },

    onSessionHostKey(callback: (prompt: SSHHostKeyPrompt) => void): () => void {
      return listenSsh<SSHHostKeyPrompt>(SSH_EVENTS.SESSION_HOST_KEY, callback)
    },

    onSessionEnded(callback: (event: SSHSessionEndedEvent) => void): () => void {
      return listenSsh<SSHSessionEndedEvent>(SSH_EVENTS.SESSION_ENDED, callback)
    }
  }
}

export const sshApi = createSSHApi()
