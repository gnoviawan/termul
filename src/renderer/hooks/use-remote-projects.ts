import { useEffect } from 'react'
import { remoteServerApi } from '@/lib/api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useRemoteStatusStore } from '@/stores/remote-status-store'

/**
 * Polls the desktop-hosted web server status into the global status store so
 * the StatusBar shows a compact indicator while the server is running.
 *
 * The legacy project-tree publishing + `remote://spawn-request` handling (the
 * old PTY bridge's `/api/projects` + `/api/spawn` flow) has been removed: the
 * ACP web server shares the desktop's live agent sessions directly over WS, so
 * there is no project-picking step for the phone client to drive.
 *
 * Mounted once near the app root. No-op outside a Tauri context.
 */
export function useRemoteProjects(): void {
  useEffect(() => {
    if (!isTauriContext()) return

    let disposed = false

    const pollStatus = async (): Promise<void> => {
      if (disposed) return
      const result = await remoteServerApi.status()
      if (!disposed && result.success) {
        useRemoteStatusStore.getState().setStatus(result.data)
      }
    }
    void pollStatus()
    const statusTimer = setInterval(() => void pollStatus(), 3000)

    return () => {
      disposed = true
      clearInterval(statusTimer)
    }
  }, [])
}
