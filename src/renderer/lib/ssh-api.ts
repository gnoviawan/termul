import type { IpcResult } from '@shared/types/ipc.types'
import type {
  ActivePortForward,
  PortForwardConfig,
  PortForwardStatusCallback,
  SFTPEntry,
  SFTPTransferProgress,
  SSHApi,
  SSHConnection,
  SSHConnectionStatus,
  SSHConnectionStatusCallback,
  SSHProfile,
  TransferProgressCallback
} from '@shared/types/ssh.types'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { runtimeT } from '@/i18n/runtime'
import { persistenceApi } from './persistence-api'
import { cleanupTauriListener, isTauriContext } from './tauri-runtime'

/** Web mode: SSH profiles live in the server-side store (issue #613). */
const SSH_PROFILES_KEY = 'ssh/profiles'

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
  const result = await persistenceApi.read<SSHProfile[]>(SSH_PROFILES_KEY)
  if (result.success) return { success: true, data: result.data }
  if (result.code === 'KEY_NOT_FOUND') return { success: true, data: [] }
  return result
}

const SSH_EVENTS = {
  CONNECTION_STATUS_CHANGED: 'ssh-connection-status-changed',
  PORT_FORWARD_STATUS_CHANGED: 'ssh-port-forward-status-changed',
  TRANSFER_PROGRESS: 'ssh-transfer-progress'
} as const

const SSH_COMMANDS = {
  LIST_PROFILES: 'ssh_list_profiles',
  SAVE_PROFILE: 'ssh_save_profile',
  DELETE_PROFILE: 'ssh_delete_profile',
  IMPORT_CONFIG: 'ssh_import_config',
  CONNECT: 'ssh_connect',
  DISCONNECT: 'ssh_disconnect',
  GET_CONNECTIONS: 'ssh_get_connections',
  PORT_FORWARD_START: 'ssh_port_forward_start',
  PORT_FORWARD_STOP: 'ssh_port_forward_stop',
  SFTP_LIST_DIR: 'sftp_list_dir',
  SFTP_DOWNLOAD: 'sftp_download',
  SFTP_UPLOAD: 'sftp_upload',
  SFTP_DELETE: 'sftp_delete',
  SFTP_MKDIR: 'sftp_mkdir',
  SFTP_RENAME: 'sftp_rename',
  SFTP_READ_FILE: 'sftp_read_file',
  SFTP_WRITE_FILE: 'sftp_write_file',
  SFTP_CREATE_FILE: 'sftp_create_file',
  CREATE_ASKPASS: 'ssh_create_askpass'
} as const

async function invokeIpc<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<IpcResult<T>> {
  // Web/remote mode: SSH/SFTP/port-forwarding are desktop-only. Return an
  // explicit `WEB_UNSUPPORTED` result instead of invoking a Tauri-only
  // command whose stub throws `tauriUnavailable`. All SSH command methods
  // (profile CRUD, connect/disconnect, port forwarding, SFTP) and
  // `createAskpassScript` delegate through this function, so the guard is
  // applied once for the whole API.
  if (!isTauriContext()) {
    return {
      success: false,
      error: runtimeT('ssh', 'errors.webUnsupported', 'SSH is not available in the web client'),
      code: 'WEB_UNSUPPORTED'
    }
  }
  try {
    return await invoke<IpcResult<T>>(command, args)
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      code: 'INVOKE_ERROR'
    }
  }
}

export function createSSHApi(): SSHApi {
  return {
    // Profile management — CRUD works in web mode via the server-side store;
    // connect/SFTP/port-forwarding remain desktop-only (`WEB_UNSUPPORTED`).
    async listProfiles(): Promise<IpcResult<SSHProfile[]>> {
      if (!isTauriContext()) return readProfilesFromStore()
      return invokeIpc<SSHProfile[]>(SSH_COMMANDS.LIST_PROFILES)
    },

    async saveProfile(profile: SSHProfile): Promise<IpcResult<void>> {
      if (!isTauriContext()) {
        for (let attempt = 0; attempt < 5; attempt++) {
          const list = await readProfilesFromStore()
          if (!list.success) return list
          const updated = list.data.filter((p) => p.id !== profile.id)
          updated.push(toStoredProfile(profile))

          // webPersistenceApi supports CAS via an undocumented 3rd parameter `expected`
          // We cast it to any to bypass the strict signature in ipc.types.ts
          const res = await (persistenceApi.write as any)(SSH_PROFILES_KEY, updated, list.data)
          if (res.success || res.code !== 'STORE_CAS_FAILED') return res
        }
        return { success: false, error: 'Concurrent modification failed', code: 'STORE_CAS_FAILED' }
      }
      return invokeIpc<void>(SSH_COMMANDS.SAVE_PROFILE, { profile })
    },

    async deleteProfile(profileId: string): Promise<IpcResult<void>> {
      if (!isTauriContext()) {
        for (let attempt = 0; attempt < 5; attempt++) {
          const list = await readProfilesFromStore()
          if (!list.success) return list
          const updated = list.data.filter((p) => p.id !== profileId)
          if (updated.length === list.data.length) return { success: true, data: undefined }

          const res = await (persistenceApi.write as any)(SSH_PROFILES_KEY, updated, list.data)
          if (res.success || res.code !== 'STORE_CAS_FAILED') return res
        }
        return { success: false, error: 'Concurrent modification failed', code: 'STORE_CAS_FAILED' }
      }
      return invokeIpc<void>(SSH_COMMANDS.DELETE_PROFILE, { profileId })
    },

    async importConfig(): Promise<IpcResult<SSHProfile[]>> {
      return invokeIpc<SSHProfile[]>(SSH_COMMANDS.IMPORT_CONFIG)
    },

    // Connection management
    async connect(profileId: string, password?: string): Promise<IpcResult<SSHConnection>> {
      return invokeIpc<SSHConnection>(SSH_COMMANDS.CONNECT, {
        request: { profileId, password }
      })
    },

    async disconnect(connectionId: string): Promise<IpcResult<void>> {
      return invokeIpc<void>(SSH_COMMANDS.DISCONNECT, { connectionId })
    },

    async getConnections(): Promise<IpcResult<SSHConnection[]>> {
      return invokeIpc<SSHConnection[]>(SSH_COMMANDS.GET_CONNECTIONS)
    },

    // Port forwarding
    async startPortForward(
      connectionId: string,
      config: PortForwardConfig
    ): Promise<IpcResult<ActivePortForward>> {
      return invokeIpc<ActivePortForward>(SSH_COMMANDS.PORT_FORWARD_START, {
        request: {
          connectionId,
          id: config.id,
          forwardType: config.type,
          localPort: config.localPort,
          remoteHost: config.remoteHost,
          remotePort: config.remotePort,
          label: config.label
        }
      })
    },

    async stopPortForward(connectionId: string, forwardId: string): Promise<IpcResult<void>> {
      return invokeIpc<void>(SSH_COMMANDS.PORT_FORWARD_STOP, { connectionId, forwardId })
    },

    // SFTP operations
    async sftpListDir(connectionId: string, remotePath: string): Promise<IpcResult<SFTPEntry[]>> {
      return invokeIpc<SFTPEntry[]>(SSH_COMMANDS.SFTP_LIST_DIR, {
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

    // Event listeners
    onConnectionStatusChanged(callback: SSHConnectionStatusCallback): () => void {
      if (!isTauriContext()) return () => {}

      let unlisten: Promise<UnlistenFn> | undefined
      try {
        unlisten = listen<{ id: string; status: SSHConnectionStatus; error?: string }>(
          SSH_EVENTS.CONNECTION_STATUS_CHANGED,
          ({ payload }) => {
            callback(payload.id, payload.status, payload.error)
          }
        )
      } catch {
        return () => {}
      }

      return () => {
        cleanupTauriListener(unlisten)
      }
    },

    onPortForwardStatusChanged(callback: PortForwardStatusCallback): () => void {
      if (!isTauriContext()) return () => {}

      let unlisten: Promise<UnlistenFn> | undefined
      try {
        unlisten = listen<[string, ActivePortForward]>(
          SSH_EVENTS.PORT_FORWARD_STATUS_CHANGED,
          ({ payload }) => {
            callback(payload[0], payload[1])
          }
        )
      } catch {
        return () => {}
      }

      return () => {
        cleanupTauriListener(unlisten)
      }
    },

    onTransferProgress(callback: TransferProgressCallback): () => void {
      if (!isTauriContext()) return () => {}

      let unlisten: Promise<UnlistenFn> | undefined
      try {
        unlisten = listen<SFTPTransferProgress>(SSH_EVENTS.TRANSFER_PROGRESS, ({ payload }) => {
          callback(payload)
        })
      } catch {
        return () => {}
      }

      return () => {
        cleanupTauriListener(unlisten)
      }
    }
  }
}

export const sshApi = createSSHApi()

/**
 * Create an SSH_ASKPASS helper script in the temp directory.
 * Returns the path to the script.
 */
export async function createAskpassScript(password: string): Promise<IpcResult<string>> {
  return invokeIpc<string>(SSH_COMMANDS.CREATE_ASKPASS, { password })
}
