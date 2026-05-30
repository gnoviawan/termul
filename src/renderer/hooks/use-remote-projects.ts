import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { toast } from 'sonner'
import { remoteServerApi } from '@/lib/api'
import { spawnTerminalInPane } from '@/lib/terminal-spawn'
import { getDefaultCwdForProject } from '@/lib/worktree-context'
import { useProjectStore } from '@/stores/project-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { useRemoteStatusStore } from '@/stores/remote-status-store'
import { isTauriContext } from '@/lib/tauri-runtime'
import type { RemoteProjectTree } from '@shared/types/ipc.types'

/** Tauri event emitted by the remote server when a web client clicks "+". */
const EVENT_REMOTE_SPAWN_REQUEST = 'remote://spawn-request'

interface SpawnRequestPayload {
  projectId: string
}

/**
 * Build the project → terminal tree the web client browses.
 * Only terminals with a live `ptyId` are exposed (those the remote server can attach to).
 */
function buildProjectTree(): RemoteProjectTree {
  const projects = useProjectStore.getState().projects
  const terminals = useTerminalStore.getState().terminals

  return {
    projects: projects
      .filter((p) => !p.isArchived)
      .map((p) => ({
        id: p.id,
        name: p.name,
        terminals: terminals
          .filter((t) => t.projectId === p.id && Boolean(t.ptyId))
          .map((t) => ({
            ptyId: t.ptyId as string,
            name: t.name,
            cwd: t.cwd
          }))
      }))
  }
}

/**
 * Keeps the embedded remote server in sync with the renderer's project/terminal
 * model and handles "add terminal" requests coming from web clients.
 *
 * Responsibilities:
 * 1. Publish the project → terminal tree to the backend whenever projects or
 *    terminals change (debounced via store subscription), and once on mount.
 * 2. Listen for `remote://spawn-request` events and spawn a terminal into the
 *    requested project (switching to it first if it isn't active).
 *
 * Mounted once near the app root. No-op outside a Tauri context.
 */
export function useRemoteProjects(): void {
  useEffect(() => {
    if (!isTauriContext()) return

    let disposed = false

    const publish = (): void => {
      if (disposed) return
      void remoteServerApi.publishProjects(buildProjectTree())
    }

    // Initial publish + republish on any project/terminal change.
    publish()
    const unsubProjects = useProjectStore.subscribe(publish)
    const unsubTerminals = useTerminalStore.subscribe(publish)

    // Poll the remote server status into the global store so the StatusBar can
    // show a compact indicator while the server is running.
    const pollStatus = async (): Promise<void> => {
      if (disposed) return
      const result = await remoteServerApi.status()
      if (!disposed && result.success) {
        useRemoteStatusStore.getState().setStatus(result.data)
      }
    }
    void pollStatus()
    const statusTimer = setInterval(() => void pollStatus(), 3000)

    // Handle "+" requests from the web client.
    const unlistenPromise = listen<SpawnRequestPayload>(
      EVENT_REMOTE_SPAWN_REQUEST,
      async (event) => {
        const { projectId } = event.payload
        const projectStore = useProjectStore.getState()
        const project = projectStore.projects.find((p) => p.id === projectId)
        if (!project) {
          toast.error('Remote: requested project no longer exists')
          return
        }

        // Switch to the project if it isn't active, so its pane tree is loaded.
        if (projectStore.activeProjectId !== projectId) {
          projectStore.selectProject(projectId)
          // Allow the workspace store to load the project's panes.
          await new Promise((resolve) => setTimeout(resolve, 150))
        }

        const paneId = useWorkspaceStore.getState().activePaneId
        if (!paneId) {
          toast.error('Remote: no active pane to add a terminal')
          return
        }

        const appDefaultShell = useAppSettingsStore.getState().settings.defaultShell
        const maxTerminals = useAppSettingsStore.getState().settings.maxTerminalsPerProject
        const cwd = getDefaultCwdForProject(projectId)

        const result = await spawnTerminalInPane(paneId, projectId, cwd, {
          shell: project.defaultShell || appDefaultShell || undefined,
          envVars: project.envVars,
          maxTerminalsPerProject: maxTerminals
        })
        if (!result.success) {
          toast.error(result.error || 'Remote: failed to add terminal')
        } else {
          // Republish so the new terminal appears in the web client promptly.
          publish()
        }
      }
    )

    return () => {
      disposed = true
      clearInterval(statusTimer)
      unsubProjects()
      unsubTerminals()
      void unlistenPromise.then((unlisten) => unlisten()).catch(() => {})
    }
  }, [])
}
