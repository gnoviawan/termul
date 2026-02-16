import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import type { DirectoryEntry } from '@shared/types/filesystem.types'

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/')
}

function isPathWithinRoot(path: string, rootPath: string): boolean {
  return path === rootPath || path.startsWith(rootPath + '/')
}

export interface FileExplorerRootError {
  message: string
  code?: string
}

export interface FileExplorerState {
  rootPath: string | null
  expandedDirs: Set<string>
  directoryContents: Map<string, DirectoryEntry[]>
  selectedPath: string | null
  isVisible: boolean
  loadingDirs: Set<string>
  rootLoadError: FileExplorerRootError | null

  setRootPath: (path: string | null) => void
  toggleDirectory: (path: string) => Promise<void>
  refreshDirectory: (path: string) => Promise<void>
  selectPath: (path: string | null) => void
  toggleVisibility: () => void
  collapseAll: () => void
  setDirectoryContents: (path: string, entries: DirectoryEntry[]) => void
  removeDirectoryContents: (path: string) => void
  setVisible: (visible: boolean) => void
  setExpandedDirs: (dirs: Set<string>) => void
  setRootLoadError: (error: FileExplorerRootError | null) => void
  restoreExpandedDirs: (dirs: string[]) => Promise<void>
}

export const useFileExplorerStore = create<FileExplorerState>((set, get) => ({
  rootPath: null,
  expandedDirs: new Set<string>(),
  directoryContents: new Map<string, DirectoryEntry[]>(),
  selectedPath: null,
  isVisible: true,
  loadingDirs: new Set<string>(),
  rootLoadError: null,

  setRootPath: (path: string | null): void => {
    // Unwatch all previously expanded directories
    const { expandedDirs } = get()
    expandedDirs.forEach((dir) => {
      window.api.filesystem.unwatchDirectory(dir)
    })
    set({
      rootPath: path ? normalizePath(path) : null,
      expandedDirs: new Set<string>(),
      directoryContents: new Map<string, DirectoryEntry[]>(),
      selectedPath: null,
      loadingDirs: new Set<string>(),
      rootLoadError: null
    })
  },

  toggleDirectory: async (path: string): Promise<void> => {
    const normalized = normalizePath(path)
    const { expandedDirs, directoryContents, loadingDirs, rootPath } = get()
    const isRootLoad = rootPath === normalized

    if (expandedDirs.has(normalized)) {
      // Collapse
      const newExpanded = new Set(expandedDirs)
      newExpanded.delete(normalized)

      // Remove contents of this dir and any nested expanded dirs
      const newContents = new Map(directoryContents)
      newContents.delete(normalized)

      // Collect dirs to unwatch (this dir + any nested expanded children)
      const dirsToUnwatch: string[] = [normalized]

      // Also collapse any child directories
      const newExpandedFiltered = new Set<string>()
      newExpanded.forEach((dir) => {
        if (!dir.startsWith(normalized + '/')) {
          newExpandedFiltered.add(dir)
        } else {
          newContents.delete(dir)
          dirsToUnwatch.push(dir)
        }
      })

      set({ expandedDirs: newExpandedFiltered, directoryContents: newContents })

      // Unwatch collapsed directories (fire-and-forget)
      for (const dir of dirsToUnwatch) {
        window.api.filesystem.unwatchDirectory(dir)
      }
    } else {
      // Prevent duplicate expand work if already loading
      if (loadingDirs.has(normalized)) return

      // Expand - load contents
      const newLoading = new Set(loadingDirs)
      newLoading.add(normalized)
      set({ loadingDirs: newLoading })

      try {
        const result = await window.api.filesystem.readDirectory(normalized, { showHidden: false })
        if (result.success) {
          const { expandedDirs: currentExpanded, directoryContents: currentContents } = get()
          const newExpanded = new Set(currentExpanded)
          newExpanded.add(normalized)
          const newContents = new Map(currentContents)
          newContents.set(normalized, result.data)

          set({
            expandedDirs: newExpanded,
            directoryContents: newContents,
            rootLoadError: isRootLoad ? null : get().rootLoadError
          })

          // Watch this directory for changes (fire-and-forget)
          window.api.filesystem.watchDirectory(normalized)
        } else if (isRootLoad) {
          set({
            rootLoadError: {
              message: result.error,
              code: result.code
            }
          })
        }
      } catch (error) {
        if (isRootLoad) {
          const message = error instanceof Error ? error.message : 'Failed to load project files'
          set({
            rootLoadError: {
              message,
              code: 'UNKNOWN_ERROR'
            }
          })
        }
      } finally {
        const newLoadingDone = new Set(get().loadingDirs)
        newLoadingDone.delete(normalized)
        set({ loadingDirs: newLoadingDone })
      }
    }
  },

  refreshDirectory: async (path: string): Promise<void> => {
    const normalized = normalizePath(path)
    try {
      const result = await window.api.filesystem.readDirectory(normalized, { showHidden: false })
      if (result.success) {
        const { directoryContents, rootPath } = get()
        const newContents = new Map(directoryContents)
        newContents.set(normalized, result.data)
        set({
          directoryContents: newContents,
          rootLoadError: rootPath === normalized ? null : get().rootLoadError
        })
      }
    } catch {
      // Silently fail on refresh
    }
  },

  selectPath: (path: string | null): void => {
    set({ selectedPath: path })
  },

  toggleVisibility: (): void => {
    set((state) => ({ isVisible: !state.isVisible }))
  },

  collapseAll: (): void => {
    const { rootPath, expandedDirs } = get()
    // Unwatch all expanded dirs except root
    expandedDirs.forEach((dir) => {
      if (dir !== rootPath) {
        window.api.filesystem.unwatchDirectory(dir)
      }
    })
    // Keep only root contents
    const newContents = new Map<string, DirectoryEntry[]>()
    if (rootPath) {
      const existing = get().directoryContents.get(rootPath)
      if (existing) newContents.set(rootPath, existing)
    }
    set({
      expandedDirs: rootPath ? new Set([rootPath]) : new Set<string>(),
      directoryContents: newContents
    })
  },

  setDirectoryContents: (path: string, entries: DirectoryEntry[]): void => {
    const newContents = new Map(get().directoryContents)
    newContents.set(path, entries)
    set({ directoryContents: newContents })
  },

  removeDirectoryContents: (path: string): void => {
    const newContents = new Map(get().directoryContents)
    newContents.delete(path)
    set({ directoryContents: newContents })
  },

  setVisible: (visible: boolean): void => {
    set({ isVisible: visible })
  },

  setExpandedDirs: (dirs: Set<string>): void => {
    set({ expandedDirs: dirs })
  },

  setRootLoadError: (error: FileExplorerRootError | null): void => {
    set({ rootLoadError: error })
  },

  restoreExpandedDirs: async (dirs: string[]): Promise<void> => {
    const { rootPath } = get()
    if (!rootPath || dirs.length === 0) return

    const normalizedRoot = normalizePath(rootPath)

    for (const dir of dirs) {
      const normalizedDir = normalizePath(dir)

      if (normalizedDir === normalizedRoot) {
        continue
      }

      if (!isPathWithinRoot(normalizedDir, normalizedRoot)) {
        continue
      }

      try {
        await get().toggleDirectory(normalizedDir)
      } catch {
        // Skip invalid/missing directories during restore
      }
    }
  }
}))

// Selector hooks
export function useFileExplorer(): Pick<
  FileExplorerState,
  'rootPath'
  | 'expandedDirs'
  | 'directoryContents'
  | 'selectedPath'
  | 'isVisible'
  | 'loadingDirs'
  | 'rootLoadError'
> {
  return useFileExplorerStore(
    useShallow((state) => ({
      rootPath: state.rootPath,
      expandedDirs: state.expandedDirs,
      directoryContents: state.directoryContents,
      selectedPath: state.selectedPath,
      isVisible: state.isVisible,
      loadingDirs: state.loadingDirs,
      rootLoadError: state.rootLoadError
    }))
  )
}

export function useFileExplorerActions(): Pick<
  FileExplorerState,
  | 'setRootPath'
  | 'toggleDirectory'
  | 'refreshDirectory'
  | 'selectPath'
  | 'toggleVisibility'
  | 'collapseAll'
  | 'setVisible'
  | 'setExpandedDirs'
  | 'setRootLoadError'
  | 'restoreExpandedDirs'
> {
  return useFileExplorerStore(
    useShallow((state) => ({
      setRootPath: state.setRootPath,
      toggleDirectory: state.toggleDirectory,
      refreshDirectory: state.refreshDirectory,
      selectPath: state.selectPath,
      toggleVisibility: state.toggleVisibility,
      collapseAll: state.collapseAll,
      setVisible: state.setVisible,
      setExpandedDirs: state.setExpandedDirs,
      setRootLoadError: state.setRootLoadError,
      restoreExpandedDirs: state.restoreExpandedDirs
    }))
  )
}

export function useFileExplorerVisible(): boolean {
  return useFileExplorerStore((state) => state.isVisible)
}
