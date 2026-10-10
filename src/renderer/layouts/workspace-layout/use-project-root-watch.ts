import { useEffect, useRef } from 'react'
import { filesystemApi } from '@/lib/api'
import { useFileExplorerStore } from '@/stores/file-explorer-store'
import type { Project } from '@/types/project'

interface UseProjectRootWatchOptions {
  activeProject: Project | undefined
  activeProjectId: string
}

/** Syncs the file explorer root and the project root watcher on project switch. */
export function useProjectRootWatch({
  activeProject,
  activeProjectId
}: UseProjectRootWatchOptions): void {
  const prevProjectIdRef = useRef<string>('')
  const watchedRootPathRef = useRef<string | null>(null)
  const projectSwitchRequestIdRef = useRef(0)

  // Sync file explorer root path and register project root watcher when project changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeProject?.path covers the only property used
  useEffect(() => {
    const nextRootPathCandidate = activeProject?.path
    if (
      !activeProject ||
      typeof nextRootPathCandidate !== 'string' ||
      nextRootPathCandidate === ''
    ) {
      // Project removed or has no path — clear explorer root and unwatch
      useFileExplorerStore.getState().setRootPath('')
      if (watchedRootPathRef.current) {
        filesystemApi.unwatchDirectory(watchedRootPathRef.current)
        watchedRootPathRef.current = null
      }
      prevProjectIdRef.current = activeProjectId
      return
    }
    if (activeProjectId === prevProjectIdRef.current) {
      return
    }

    const nextRootPath = nextRootPathCandidate

    const switchRequestId = ++projectSwitchRequestIdRef.current
    const previousWatchedRoot = watchedRootPathRef.current

    let cancelled = false

    async function applyProjectSwitch(): Promise<void> {
      try {
        const watchResult = await filesystemApi.watchDirectory(nextRootPath)

        if (cancelled || switchRequestId !== projectSwitchRequestIdRef.current) {
          filesystemApi.unwatchDirectory(nextRootPath)
          return
        }

        if (!watchResult.success) {
          useFileExplorerStore.getState().setRootPath(nextRootPath)
          useFileExplorerStore.getState().setRootLoadError({
            message: watchResult.error,
            code: watchResult.code
          })
          return
        }

        useFileExplorerStore.getState().setRootPath(nextRootPath)

        if (previousWatchedRoot && previousWatchedRoot !== nextRootPath) {
          filesystemApi.unwatchDirectory(previousWatchedRoot)
        }

        watchedRootPathRef.current = nextRootPath
        prevProjectIdRef.current = activeProjectId
      } catch (error) {
        if (cancelled || switchRequestId !== projectSwitchRequestIdRef.current) {
          return
        }

        const message = error instanceof Error ? error.message : 'Failed to watch project directory'
        useFileExplorerStore.getState().setRootPath(nextRootPath)
        useFileExplorerStore.getState().setRootLoadError({
          message,
          code: 'WATCH_FAILED'
        })
      }
    }

    void applyProjectSwitch()

    return () => {
      cancelled = true
    }
  }, [activeProject?.path, activeProjectId])

  useEffect(() => {
    return () => {
      if (watchedRootPathRef.current) {
        filesystemApi.unwatchDirectory(watchedRootPathRef.current)
      }
    }
  }, [])
}
