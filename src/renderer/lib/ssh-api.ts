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
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
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
} as const

async function invokeIpc<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<IpcResult<T>> {
  // Web/remote mode: SSH/SFTP/port-forwarding are desktop-only. Return an
  // explicit `WEB_UNSUPPORTED` result instead of invoking a Tauri-only
  // command whose stub throws `tauriUnavailable`. All SSH command methods
  // (profile CRUD, sessions, port forwarding, SFTP) delegate through this
  // function, so the guard is applied once for the whole API.
  if (!isTauriContext()) {
    return {
      success: false,
      error: 'SSH is not available in the web client',
      code: 'WEB_UNSUPPORTED'
    }
  }
  return invokeTauriIpc<T>(command, args)
}

/** Subscribe to a Tauri event; a no-op outside the desktop runtime. */
function listenDesktop<T>(event: string, callback: (payload: T) => void): () => void {
  if (!isTauriContext()) return () => {}
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
    // Profile management — CRUD works in web mode via the server-side store;
    // sessions/SFTP/port-forwarding remain desktop-only (`WEB_UNSUPPORTED`).
    async listProfiles(): Promise<IpcResult<SSHProfile[]>> {
      if (!isTauriContext()) return readProfilesFromStore()
      return invokeIpc<SSHProfile[]>(SSH_COMMANDS.LIST_PROFILES)
    },

    async saveProfile(profile: SSHProfile): Promise<IpcResult<void>> {
      if (!isTauriContext()) {
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
      if (!isTauriContext()) {
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
      return listenDesktop<[string, ActivePortForward]>(
        SSH_EVENTS.PORT_FORWARD_STATUS_CHANGED,
        (payload) => callback(payload[0], payload[1])
      )
    },

    onTransferProgress(callback: TransferProgressCallback): () => void {
      return listenDesktop<SFTPTransferProgress>(SSH_EVENTS.TRANSFER_PROGRESS, callback)
    },

    onSessionProgress(callback: (event: SSHSessionProgressEvent) => void): () => void {
      return listenDesktop<SSHSessionProgressEvent>(SSH_EVENTS.SESSION_PROGRESS, callback)
    },

    onSessionHostKey(callback: (prompt: SSHHostKeyPrompt) => void): () => void {
      return listenDesktop<SSHHostKeyPrompt>(SSH_EVENTS.SESSION_HOST_KEY, callback)
    },

    onSessionEnded(callback: (event: SSHSessionEndedEvent) => void): () => void {
      return listenDesktop<SSHSessionEndedEvent>(SSH_EVENTS.SESSION_ENDED, callback)
    }
  }
}

export const sshApi = createSSHApi()
