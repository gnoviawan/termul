import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import type { DirectoryEntry } from '@shared/types/filesystem.types'
import { filesystemApi } from '@/lib/api'

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/')
}

function isPathWithinRoot(path: string, rootPath: string): boolean {
  return path === rootPath || path.startsWith(rootPath + '/')
}

/**
 * Copy a file or directory to a new location
 */
async function copyPath(srcPath: string, destPath: string): Promise<void> {
  // For now, we implement copy by reading and writing
  // This is a simplified implementation - a production version would need
  // to handle directories recursively and be more efficient
  try {
    // Try to read the source as a file first
    const readResult = await filesystemApi.readFile(srcPath)
    if (readResult.success) {
      await filesystemApi.writeFile(destPath, readResult.data.content)
    }
  } catch {
    // If it's a directory, we'd need recursive copy
    // For simplicity, we'll create the directory
    await filesystemApi.createDirectory(destPath)
  }
}

export interface FileExplorerRootError {
  message: string
  code?: string
}

export interface FileClipboard {
  type: 'copy' | 'cut'
  paths: string[]
}

export interface FileExplorerState {
  rootPath: string | null
  expandedDirs: Set<string>
  directoryContents: Map<string, DirectoryEntry[]>
  selectedPaths: Set<string>
  lastClickedPath: string | null
  clipboard: FileClipboard | null
  isVisible: boolean
  loadingDirs: Set<string>
  rootLoadError: FileExplorerRootError | null

  setRootPath: (path: string | null) => void
  toggleDirectory: (path: string) => Promise<void>
  refreshDirectory: (path: string) => Promise<void>
  selectPath: (path: string | null) => void
  togglePathSelection: (path: string) => void
  selectPathRange: (fromPath: string, toPath: string) => void
  selectAll: () => void
  clearSelection: () => void
  copySelected: () => void
  cutSelected: () => void
  paste: (destinationPath: string) => Promise<void>
  duplicateSelected: () => Promise<void>
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
  selectedPaths: new Set<string>(),
  lastClickedPath: null,
  clipboard: null,
  isVisible: true,
  loadingDirs: new Set<string>(),
  rootLoadError: null,

  setRootPath: (path: string | null): void => {
    // Unwatch all previously expanded directories
    const { expandedDirs } = get()
    expandedDirs.forEach((dir) => {
      filesystemApi.unwatchDirectory(dir)
    })
    set({
      rootPath: path ? normalizePath(path) : null,
      expandedDirs: new Set<string>(),
      directoryContents: new Map<string, DirectoryEntry[]>(),
      selectedPaths: new Set<string>(),
      lastClickedPath: null,
      clipboard: null,
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
        filesystemApi.unwatchDirectory(dir)
      }
    } else {
      // Prevent duplicate expand work if already loading
      if (loadingDirs.has(normalized)) return

      // Expand - load contents
      const newLoading = new Set(loadingDirs)
      newLoading.add(normalized)
      set({ loadingDirs: newLoading })

      try {
        const result = await filesystemApi.readDirectory(normalized)
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
          filesystemApi.watchDirectory(normalized)
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
      const result = await filesystemApi.readDirectory(normalized)
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
    set({
      selectedPaths: path ? new Set([normalizePath(path)]) : new Set<string>(),
      lastClickedPath: path ? normalizePath(path) : null
    })
  },

  togglePathSelection: (path: string): void => {
    const normalized = normalizePath(path)
    const { selectedPaths } = get()
    const newSet = new Set(selectedPaths)

    if (newSet.has(normalized)) {
      newSet.delete(normalized)
    } else {
      newSet.add(normalized)
    }

    set({ selectedPaths: newSet, lastClickedPath: normalized })
  },

  selectPathRange: (fromPath: string, toPath: string): void => {
    const normalizedFrom = normalizePath(fromPath)
    const normalizedTo = normalizePath(toPath)
    const { directoryContents, rootPath, expandedDirs } = get()

    // Collect all visible paths in order
    const allPaths: string[] = []

    function collectPaths(dirPath: string): void {
      const contents = directoryContents.get(dirPath)
      if (!contents) return

      for (const entry of contents) {
        allPaths.push(entry.path)
        if (entry.type === 'directory' && expandedDirs.has(entry.path)) {
          collectPaths(entry.path)
        }
      }
    }

    if (rootPath) {
      collectPaths(rootPath)
    }

    // Find indices
    const fromIndex = allPaths.indexOf(normalizedFrom)
    const toIndex = allPaths.indexOf(normalizedTo)

    if (fromIndex === -1 || toIndex === -1) return

    const start = Math.min(fromIndex, toIndex)
    const end = Math.max(fromIndex, toIndex)

    const newSet = new Set(get().selectedPaths)
    for (let i = start; i <= end; i++) {
      newSet.add(allPaths[i])
    }

    set({ selectedPaths: newSet, lastClickedPath: normalizedTo })
  },

  selectAll: (): void => {
    const { directoryContents, rootPath, expandedDirs } = get()
    const allPaths: string[] = []

    function collectPaths(dirPath: string): void {
      const contents = directoryContents.get(dirPath)
      if (!contents) return

      for (const entry of contents) {
        allPaths.push(entry.path)
        if (entry.type === 'directory' && expandedDirs.has(entry.path)) {
          collectPaths(entry.path)
        }
      }
    }

    if (rootPath) {
      collectPaths(rootPath)
    }

    set({ selectedPaths: new Set(allPaths) })
  },

  clearSelection: (): void => {
    set({ selectedPaths: new Set<string>(), lastClickedPath: null })
  },

  copySelected: (): void => {
    const { selectedPaths } = get()
    if (selectedPaths.size === 0) return

    set({ clipboard: { type: 'copy', paths: Array.from(selectedPaths) } })
  },

  cutSelected: (): void => {
    const { selectedPaths } = get()
    if (selectedPaths.size === 0) return

    set({ clipboard: { type: 'cut', paths: Array.from(selectedPaths) } })
  },

  paste: async (destinationPath: string): Promise<void> => {
    const { clipboard, refreshDirectory } = get()
    if (!clipboard || clipboard.paths.length === 0) return

    const normalizedDest = normalizePath(destinationPath)
    const isDirectory = await (async () => {
      try {
        const result = await filesystemApi.getFileInfo(normalizedDest)
        return result.success && result.data ? true : false
      } catch {
        return false
      }
    })()

    const targetDir = isDirectory ? normalizedDest : normalizedDest.substring(0, normalizedDest.lastIndexOf('/'))

    for (const srcPath of clipboard.paths) {
      const normalizedSrc = normalizePath(srcPath)
      const fileName = normalizedSrc.substring(normalizedSrc.lastIndexOf('/') + 1)
      const destPath = `${targetDir}/${fileName}`

      if (clipboard.type === 'copy') {
        // Copy file/folder
        await copyPath(normalizedSrc, destPath)
      } else {
        // Move file/folder
        const renameResult = await filesystemApi.renameFile(normalizedSrc, destPath)
        if (!renameResult.success) {
          console.error('Failed to move:', renameResult.error)
        }
      }
    }

    // Clear clipboard after cut operation
    if (clipboard.type === 'cut') {
      set({ clipboard: null })
    }

    await refreshDirectory(targetDir)
  },

  duplicateSelected: async (): Promise<void> => {
    const { selectedPaths, refreshDirectory } = get()
    if (selectedPaths.size === 0) return

    for (const path of selectedPaths) {
      const normalized = normalizePath(path)
      const lastSlash = normalized.lastIndexOf('/')
      const dir = lastSlash > 0 ? normalized.substring(0, lastSlash) : ''
      const fileName = normalized.substring(lastSlash + 1)

      // Generate duplicate name
      const dotIndex = fileName.lastIndexOf('.')
      const baseName = dotIndex > 0 ? fileName.substring(0, dotIndex) : fileName
      const ext = dotIndex > 0 ? fileName.substring(dotIndex) : ''
      const newName = `${baseName} (copy)${ext}`
      const destPath = `${dir}/${newName}`

      await copyPath(normalized, destPath)

      if (dir) {
        await refreshDirectory(dir)
      }
    }
  },

  toggleVisibility: (): void => {
    set((state) => ({ isVisible: !state.isVisible }))
  },

  collapseAll: (): void => {
    const { rootPath, expandedDirs } = get()
    // Unwatch all expanded dirs except root
    expandedDirs.forEach((dir) => {
      if (dir !== rootPath) {
        filesystemApi.unwatchDirectory(dir)
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
    const normalized = normalizePath(path)
    const newContents = new Map(get().directoryContents)
    newContents.set(normalized, entries)
    set({ directoryContents: newContents })
  },

  removeDirectoryContents: (path: string): void => {
    const normalized = normalizePath(path)
    const newContents = new Map(get().directoryContents)
    newContents.delete(normalized)
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
  | 'selectedPaths'
  | 'lastClickedPath'
  | 'clipboard'
  | 'isVisible'
  | 'loadingDirs'
  | 'rootLoadError'
> {
  return useFileExplorerStore(
    useShallow((state) => ({
      rootPath: state.rootPath,
      expandedDirs: state.expandedDirs,
      directoryContents: state.directoryContents,
      selectedPaths: state.selectedPaths,
      lastClickedPath: state.lastClickedPath,
      clipboard: state.clipboard,
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
  | 'togglePathSelection'
  | 'selectPathRange'
  | 'selectAll'
  | 'clearSelection'
  | 'copySelected'
  | 'cutSelected'
  | 'paste'
  | 'duplicateSelected'
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
      togglePathSelection: state.togglePathSelection,
      selectPathRange: state.selectPathRange,
      selectAll: state.selectAll,
      clearSelection: state.clearSelection,
      copySelected: state.copySelected,
      cutSelected: state.cutSelected,
      paste: state.paste,
      duplicateSelected: state.duplicateSelected,
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
