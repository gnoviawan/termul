import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { IpcResult } from '@shared/types/ipc.types'
import type {
  SSHProfile,
  SSHConnection,
  SSHConnectionStatus,
  SSHApi,
  SSHConnectionStatusCallback,
  PortForwardStatusCallback,
  TransferProgressCallback,
  PortForwardConfig,
  ActivePortForward,
  SFTPEntry,
  SFTPTransferProgress,
} from '@shared/types/ssh.types'
import { isTauriContext, cleanupTauriListener } from './tauri-runtime'

const SSH_EVENTS = {
  CONNECTION_STATUS_CHANGED: 'ssh-connection-status-changed',
  PORT_FORWARD_STATUS_CHANGED: 'ssh-port-forward-status-changed',
  TRANSFER_PROGRESS: 'ssh-transfer-progress',
} as const

const SSH_COMMANDS = {
  LIST_PROFILES: 'ssh_list_profiles',
  SAVE_PROFILE: 'ssh_save_profile',
  DELETE_PROFILE: 'ssh_delete_profile',
  IMPORT_CONFIG: 'ssh_import_config',
  CONNECT: 'ssh_connect',
  DISCONNECT: 'ssh_disconnect',
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
  CREATE_ASKPASS: 'ssh_create_askpass',
} as const

async function invokeIpc<T>(command: string, args?: Record<string, unknown>): Promise<IpcResult<T>> {
  try {
    return await invoke<IpcResult<T>>(command, args)
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      code: 'INVOKE_ERROR',
    }
  }
}

export function createSSHApi(): SSHApi {
  return {
    // Profile management
    async listProfiles(): Promise<IpcResult<SSHProfile[]>> {
      return invokeIpc<SSHProfile[]>(SSH_COMMANDS.LIST_PROFILES)
    },

    async saveProfile(profile: SSHProfile): Promise<IpcResult<void>> {
      return invokeIpc<void>(SSH_COMMANDS.SAVE_PROFILE, { profile })
    },

    async deleteProfile(profileId: string): Promise<IpcResult<void>> {
      return invokeIpc<void>(SSH_COMMANDS.DELETE_PROFILE, { profileId })
    },

    async importConfig(): Promise<IpcResult<SSHProfile[]>> {
      return invokeIpc<SSHProfile[]>(SSH_COMMANDS.IMPORT_CONFIG)
    },

    // Connection management
    async connect(profileId: string, password?: string): Promise<IpcResult<SSHConnection>> {
      return invokeIpc<SSHConnection>(SSH_COMMANDS.CONNECT, {
        request: { profileId, password },
      })
    },

    async disconnect(connectionId: string): Promise<IpcResult<void>> {
      return invokeIpc<void>(SSH_COMMANDS.DISCONNECT, { connectionId })
    },

    async getConnections(): Promise<IpcResult<SSHConnection[]>> {
      // Connections are tracked client-side via events
      return { success: true, data: [] }
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
          label: config.label,
        },
      })
    },

    async stopPortForward(connectionId: string, forwardId: string): Promise<IpcResult<void>> {
      return invokeIpc<void>(SSH_COMMANDS.PORT_FORWARD_STOP, { connectionId, forwardId })
    },

    // SFTP operations
    async sftpListDir(connectionId: string, remotePath: string): Promise<IpcResult<SFTPEntry[]>> {
      return invokeIpc<SFTPEntry[]>(SSH_COMMANDS.SFTP_LIST_DIR, {
        request: { connectionId, remotePath },
      })
    },

    async sftpDownload(
      connectionId: string,
      remotePath: string,
      localPath: string
    ): Promise<IpcResult<void>> {
      return invokeIpc<void>(SSH_COMMANDS.SFTP_DOWNLOAD, {
        request: { connectionId, remotePath, localPath },
      })
    },

    async sftpUpload(
      connectionId: string,
      localPath: string,
      remotePath: string
    ): Promise<IpcResult<void>> {
      return invokeIpc<void>(SSH_COMMANDS.SFTP_UPLOAD, {
        request: { connectionId, remotePath, localPath },
      })
    },

    async sftpDelete(connectionId: string, remotePath: string): Promise<IpcResult<void>> {
      return invokeIpc<void>(SSH_COMMANDS.SFTP_DELETE, {
        request: { connectionId, remotePath },
      })
    },

    async sftpMkdir(connectionId: string, remotePath: string): Promise<IpcResult<void>> {
      return invokeIpc<void>(SSH_COMMANDS.SFTP_MKDIR, {
        request: { connectionId, remotePath },
      })
    },

    async sftpRename(
      connectionId: string,
      oldPath: string,
      newPath: string
    ): Promise<IpcResult<void>> {
      return invokeIpc<void>(SSH_COMMANDS.SFTP_RENAME, {
        request: { connectionId, oldPath, newPath },
      })
    },

    async sftpReadFile(connectionId: string, remotePath: string): Promise<IpcResult<string>> {
      return invokeIpc<string>(SSH_COMMANDS.SFTP_READ_FILE, {
        request: { connectionId, remotePath },
      })
    },

    async sftpWriteFile(connectionId: string, remotePath: string, content: string): Promise<IpcResult<void>> {
      return invokeIpc<void>(SSH_COMMANDS.SFTP_WRITE_FILE, {
        request: { connectionId, remotePath, content },
      })
    },

    async sftpCreateFile(connectionId: string, remotePath: string): Promise<IpcResult<void>> {
      return invokeIpc<void>(SSH_COMMANDS.SFTP_CREATE_FILE, {
        request: { connectionId, remotePath },
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

      return () => { cleanupTauriListener(unlisten) }
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

      return () => { cleanupTauriListener(unlisten) }
    },

    onTransferProgress(callback: TransferProgressCallback): () => void {
      if (!isTauriContext()) return () => {}

      let unlisten: Promise<UnlistenFn> | undefined
      try {
        unlisten = listen<SFTPTransferProgress>(
          SSH_EVENTS.TRANSFER_PROGRESS,
          ({ payload }) => {
            callback(payload)
          }
        )
      } catch {
        return () => {}
      }

      return () => { cleanupTauriListener(unlisten) }
    },
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
