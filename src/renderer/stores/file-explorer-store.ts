import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import type { DirectoryEntry } from '@shared/types/filesystem.types'

export interface FileExplorerState {
  rootPath: string | null
  expandedDirs: Set<string>
  directoryContents: Map<string, DirectoryEntry[]>
  selectedPath: string | null
  isVisible: boolean
  loadingDirs: Set<string>

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
}

export const useFileExplorerStore = create<FileExplorerState>((set, get) => ({
  rootPath: null,
  expandedDirs: new Set<string>(),
  directoryContents: new Map<string, DirectoryEntry[]>(),
  selectedPath: null,
  isVisible: true,
  loadingDirs: new Set<string>(),

  setRootPath: (path: string | null): void => {
    // Unwatch all previously expanded directories
    const { expandedDirs } = get()
    expandedDirs.forEach((dir) => {
      window.api.filesystem.unwatchDirectory(dir)
    })
    set({
      rootPath: path,
      expandedDirs: new Set<string>(),
      directoryContents: new Map<string, DirectoryEntry[]>(),
      selectedPath: null,
      loadingDirs: new Set<string>()
    })
  },

  toggleDirectory: async (path: string): Promise<void> => {
    const { expandedDirs, directoryContents, loadingDirs } = get()

    if (expandedDirs.has(path)) {
      // Collapse
      const newExpanded = new Set(expandedDirs)
      newExpanded.delete(path)

      // Remove contents of this dir and any nested expanded dirs
      const newContents = new Map(directoryContents)
      newContents.delete(path)

      // Collect dirs to unwatch (this dir + any nested expanded children)
      const dirsToUnwatch: string[] = [path]

      // Also collapse any child directories
      const newExpandedFiltered = new Set<string>()
      newExpanded.forEach((dir) => {
        if (!dir.startsWith(path + '/')) {
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
      // Expand - load contents
      const newLoading = new Set(loadingDirs)
      newLoading.add(path)
      set({ loadingDirs: newLoading })

      try {
        const result = await window.api.filesystem.readDirectory(path, { showHidden: false })
        if (result.success) {
          const { expandedDirs: currentExpanded, directoryContents: currentContents } = get()
          const newExpanded = new Set(currentExpanded)
          newExpanded.add(path)
          const newContents = new Map(currentContents)
          newContents.set(path, result.data)

          const newLoadingDone = new Set(get().loadingDirs)
          newLoadingDone.delete(path)

          set({
            expandedDirs: newExpanded,
            directoryContents: newContents,
            loadingDirs: newLoadingDone
          })

          // Watch this directory for changes (fire-and-forget)
          window.api.filesystem.watchDirectory(path)
        } else {
          const newLoadingDone = new Set(get().loadingDirs)
          newLoadingDone.delete(path)
          set({ loadingDirs: newLoadingDone })
        }
      } catch {
        const newLoadingDone = new Set(get().loadingDirs)
        newLoadingDone.delete(path)
        set({ loadingDirs: newLoadingDone })
      }
    }
  },

  refreshDirectory: async (path: string): Promise<void> => {
    try {
      const result = await window.api.filesystem.readDirectory(path, { showHidden: false })
      if (result.success) {
        const { directoryContents } = get()
        const newContents = new Map(directoryContents)
        newContents.set(path, result.data)
        set({ directoryContents: newContents })
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
  }
}))

// Selector hooks
export function useFileExplorer(): Pick<
  FileExplorerState,
  'rootPath' | 'expandedDirs' | 'directoryContents' | 'selectedPath' | 'isVisible' | 'loadingDirs'
> {
  return useFileExplorerStore(
    useShallow((state) => ({
      rootPath: state.rootPath,
      expandedDirs: state.expandedDirs,
      directoryContents: state.directoryContents,
      selectedPath: state.selectedPath,
      isVisible: state.isVisible,
      loadingDirs: state.loadingDirs
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
      setExpandedDirs: state.setExpandedDirs
    }))
  )
}

export function useFileExplorerVisible(): boolean {
  return useFileExplorerStore((state) => state.isVisible)
}
