import type { DirectoryEntry, FileSearchResult } from '@shared/types/filesystem.types'
import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import { filesystemApi } from '@/lib/api'

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/')
}

function isPathWithinRoot(path: string, rootPath: string): boolean {
  return path === rootPath || path.startsWith(`${rootPath}/`)
}

/**
 * Copy a file or directory to a new location.
 *
 * Uses binary-safe `copyFile` to avoid UTF-8 round-trip corruption on binary
 * files (images, fonts, compiled artifacts). When `copyFile` fails, verifies
 * the source is actually a directory before creating one at the destination —
 * this avoids masking real failures (permissions, missing source, disk full)
 * behind an empty directory. Note: recursive directory copy is not yet
 * supported; only an empty directory is created.
 */
async function copyPath(srcPath: string, destPath: string): Promise<void> {
  const result = await filesystemApi.copyFile(srcPath, destPath)
  if (!result.success) {
    // copyFile fails on directories — confirm the source is actually a
    // directory before creating one, so we don't mask real copy failures.
    const info = await filesystemApi.getFileInfo(srcPath)
    if (info.success && info.data.type === 'directory') {
      await filesystemApi.createDirectory(destPath)
    }
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

interface PendingDirectoryCollapse {
  contentPathsToRemove: string[]
  dirsToUnwatch: string[]
}

/** Worktree root override - when set, explorer roots at worktree path instead of project root */
export type WorktreeRootOverride = string | null

export interface FileExplorerState {
  rootPath: string | null
  /** Trusted project boundary for search IPC validation */
  scopeRoot: string | null
  /** Active worktree root override */
  worktreeRoot: string | null
  expandedDirs: Set<string>
  directoryContents: Map<string, DirectoryEntry[]>
  selectedPaths: Set<string>
  lastClickedPath: string | null
  clipboard: FileClipboard | null
  isVisible: boolean
  loadingDirs: Set<string>
  rootLoadError: FileExplorerRootError | null
  searchQuery: string
  searchResults: FileSearchResult[]
  searchFileNameMatches: string[] | null
  searchLoading: boolean
  searchError: string | null
  /**
   * Programmatic error code paired with `searchError`. Set when the
   * streaming done event carries a `code`; otherwise `null`. Values come
   * from `FilesystemApi`'s `onSearchContentDone` / `onSearchFileNamesDone`
   * event types (e.g. `QUERY_TOO_LONG`, `RG_STREAM_FAILED`).
   */
  searchErrorCode: string | null
  searchTruncated: boolean
  searchScannedFiles: number
  searchFailedFiles: number
  searchRequestId: number
  searchLastCompletedQuery: string
  /** Deferred directory cleanup while collapse exit animation runs */
  pendingCollapses: Map<string, PendingDirectoryCollapse>
  /** Skip tree motion (e.g. collapse all) */
  suppressTreeAnimations: boolean
  /** True while a header-initiated refreshTree pass is in flight (GH-540). */
  refreshingTree: boolean

  setRootPath: (path: string | null) => void
  setWorktreeRoot: (path: string | null) => void
  toggleDirectory: (path: string) => Promise<void>
  finalizeDirectoryCollapse: (path: string) => void
  refreshDirectory: (path: string) => Promise<void>
  /** Re-read the root and every expanded directory (GH-540 header Refresh). */
  refreshTree: () => Promise<void>
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
  setSearchQuery: (query: string) => void
  searchInRoot: (query: string, requestId: number) => Promise<void>
  resetSearch: () => void
}

let streamSubscribed = false
let fileNameStreamSubscribed = false

function ensureSearchStreamSubscription(
  set: (partial: Partial<FileExplorerState>) => void,
  get: () => FileExplorerState
): void {
  if (streamSubscribed) return
  streamSubscribed = true

  filesystemApi.onSearchContentBatch((event) => {
    const state = get()
    const activeId = `search-${state.searchRequestId}`
    if (event.searchId !== activeId) return

    const merged = new Map(state.searchResults.map((file) => [file.filePath, file]))
    for (const file of event.results) merged.set(file.filePath, file)

    set({
      searchResults: Array.from(merged.values()),
      searchTruncated: event.truncated || state.searchTruncated
    })
  })

  filesystemApi.onSearchContentDone((event) => {
    const state = get()
    const activeId = `search-${state.searchRequestId}`
    if (event.searchId !== activeId) return

    set({
      searchLoading: false,
      searchError: event.error ?? null,
      // Surface the programmatic code so consumers (telemetry, future UI
      // affordances) can distinguish QUERY_TOO_LONG from RG_STREAM_FAILED
      // without parsing the human-readable error string.
      searchErrorCode: event.code ?? null,
      searchTruncated: event.truncated,
      searchScannedFiles: event.scannedFiles,
      searchFailedFiles: event.failedFiles,
      searchLastCompletedQuery: state.searchQuery.trim()
    })
  })
}

function ensureFileNameStreamSubscription(
  set: (partial: Partial<FileExplorerState>) => void,
  get: () => FileExplorerState
): void {
  if (fileNameStreamSubscribed) return
  fileNameStreamSubscribed = true

  filesystemApi.onSearchFileNamesBatch((event) => {
    const state = get()
    const activeId = `search-${state.searchRequestId}`
    if (event.searchId !== activeId) return

    set({
      searchFileNameMatches: event.files.map((f) => f.path),
      searchTruncated: event.truncated || state.searchTruncated
    })
  })

  filesystemApi.onSearchFileNamesDone((event) => {
    const state = get()
    const activeId = `search-${state.searchRequestId}`
    if (event.searchId !== activeId) return

    // Surface backend errors and stop the spinner. Filename and content
    // streams share the same `searchError` / `searchLoading` slot; the
    // content stream's own done handler is the source of truth for
    // `searchLastCompletedQuery` and overwrites these fields when it
    // fires, so mirroring the error here is safe.
    const next: Partial<FileExplorerState> = {
      searchTruncated: event.truncated || state.searchTruncated,
      searchLoading: false
    }
    if (event.error) {
      next.searchError = event.error
    }
    // Surface the programmatic code in the same slot as content search so
    // downstream consumers can branch on QUERY_TOO_LONG vs RG_STREAM_FAILED
    // without parsing the message. If the content stream fires afterwards,
    // its own `code` will overwrite this value (which is correct — that
    // event is the source of truth for the overall search result).
    if (event.code) {
      next.searchErrorCode = event.code
    } else if (!event.error) {
      // No error, no code: clear any stale code from a prior search.
      next.searchErrorCode = null
    }
    if (state.searchFileNameMatches === null) {
      // No batch ever landed (zero matches, no trailing flush). Drop the
      // pending placeholder so the tab shows `0` rather than `…` forever.
      next.searchFileNameMatches = []
    }
    set(next)
  })
}

export const useFileExplorerStore = create<FileExplorerState>((set, get) => ({
  rootPath: null,
  scopeRoot: null,
  worktreeRoot: null,
  expandedDirs: new Set<string>(),
  directoryContents: new Map<string, DirectoryEntry[]>(),
  selectedPaths: new Set<string>(),
  lastClickedPath: null,
  clipboard: null,
  isVisible: true,
  loadingDirs: new Set<string>(),
  rootLoadError: null,
  searchQuery: '',
  searchResults: [],
  searchFileNameMatches: null,
  searchLoading: false,
  searchError: null,
  searchErrorCode: null,
  searchTruncated: false,
  searchScannedFiles: 0,
  searchFailedFiles: 0,
  searchRequestId: 0,
  searchLastCompletedQuery: '',
  pendingCollapses: new Map<string, PendingDirectoryCollapse>(),
  suppressTreeAnimations: false,
  refreshingTree: false,

  setRootPath: (path: string | null): void => {
    // Unwatch all previously expanded directories
    const { expandedDirs, searchRequestId } = get()
    if (searchRequestId > 0) {
      const sid = `search-${searchRequestId}`
      filesystemApi.searchContentStreamCancel(sid).catch((e) => {
        console.warn(`[file-explorer] searchContentStreamCancel(${sid}) failed:`, e)
      })
      filesystemApi.searchFileNamesStreamCancel(sid).catch((e) => {
        console.warn(`[file-explorer] searchFileNamesStreamCancel(${sid}) failed:`, e)
      })
    }
    expandedDirs.forEach((dir) => {
      filesystemApi.unwatchDirectory(dir)
    })
    const normalized = path ? normalizePath(path) : null
    set({
      rootPath: normalized,
      scopeRoot: normalized,
      expandedDirs: new Set<string>(),
      directoryContents: new Map<string, DirectoryEntry[]>(),
      selectedPaths: new Set<string>(),
      lastClickedPath: null,
      clipboard: null,
      loadingDirs: new Set<string>(),
      rootLoadError: null,
      searchQuery: '',
      searchResults: [],
      searchFileNameMatches: null,
      searchLoading: false,
      searchError: null,
      searchErrorCode: null,
      searchTruncated: false,
      searchScannedFiles: 0,
      searchFailedFiles: 0,
      searchRequestId: 0,
      searchLastCompletedQuery: '',
      pendingCollapses: new Map<string, PendingDirectoryCollapse>(),
      suppressTreeAnimations: false
    })
  },

  setWorktreeRoot: (path: string | null): void => {
    const { scopeRoot, searchRequestId } = get()
    if (searchRequestId > 0) {
      const sid = `search-${searchRequestId}`
      filesystemApi.searchContentStreamCancel(sid).catch((e) => {
        console.warn(`[file-explorer] searchContentStreamCancel(${sid}) failed:`, e)
      })
      filesystemApi.searchFileNamesStreamCancel(sid).catch((e) => {
        console.warn(`[file-explorer] searchFileNamesStreamCancel(${sid}) failed:`, e)
      })
    }
    const worktreeRoot = path ? normalizePath(path) : null
    set({
      worktreeRoot,
      rootPath: worktreeRoot ?? scopeRoot,
      searchQuery: '',
      searchResults: [],
      searchFileNameMatches: null,
      searchLoading: false,
      searchError: null,
      searchErrorCode: null,
      searchTruncated: false,
      searchScannedFiles: 0,
      searchFailedFiles: 0,
      searchRequestId: 0,
      searchLastCompletedQuery: ''
    })
  },

  toggleDirectory: async (path: string): Promise<void> => {
    const normalized = normalizePath(path)
    const { expandedDirs, loadingDirs, rootPath } = get()
    const isRootLoad = rootPath === normalized

    if (expandedDirs.has(normalized)) {
      // Collapse: update expanded state immediately; defer content cleanup for exit animation
      const newExpanded = new Set(expandedDirs)
      newExpanded.delete(normalized)

      const contentPathsToRemove: string[] = [normalized]
      const dirsToUnwatch: string[] = [normalized]

      const newExpandedFiltered = new Set<string>()
      newExpanded.forEach((dir) => {
        if (!dir.startsWith(`${normalized}/`)) {
          newExpandedFiltered.add(dir)
        } else {
          contentPathsToRemove.push(dir)
          dirsToUnwatch.push(dir)
        }
      })

      const newPending = new Map(get().pendingCollapses)
      newPending.set(normalized, { contentPathsToRemove, dirsToUnwatch })

      set({ expandedDirs: newExpandedFiltered, pendingCollapses: newPending })
    } else {
      // Cancel deferred collapse cleanup when re-expanding before animation finishes
      const pending = get().pendingCollapses
      if (pending.has(normalized)) {
        const newPending = new Map(pending)
        newPending.delete(normalized)
        set({ pendingCollapses: newPending })
      }

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

  refreshTree: async (): Promise<void> => {
    const { rootPath } = get()
    if (!rootPath || get().refreshingTree) return

    set({ refreshingTree: true })
    try {
      const capturedRoot = rootPath
      // Only re-read directories that belong to the current root; stale
      // expanded dirs from a previous worktree override must not be fetched.
      const dirsToRefresh = new Set<string>([
        rootPath,
        ...Array.from(get().expandedDirs).filter((dir) => isPathWithinRoot(dir, rootPath))
      ])

      // Sequential on purpose: re-check live state before each read so a
      // collapse or project switch that lands mid-refresh is honored instead
      // of being overwritten by stale in-flight results.
      for (const dir of dirsToRefresh) {
        const state = get()
        if (state.rootPath !== capturedRoot) return
        if (dir !== capturedRoot && !state.expandedDirs.has(dir)) continue
        await state.refreshDirectory(dir)
      }
    } finally {
      set({ refreshingTree: false })
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
        return !!(result.success && result.data)
      } catch {
        return false
      }
    })()

    const targetDir = isDirectory
      ? normalizedDest
      : normalizedDest.substring(0, normalizedDest.lastIndexOf('/'))

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

  finalizeDirectoryCollapse: (path: string): void => {
    const normalized = normalizePath(path)
    const pending = get().pendingCollapses.get(normalized)
    if (!pending) return

    const newContents = new Map(get().directoryContents)
    for (const contentPath of pending.contentPathsToRemove) {
      newContents.delete(contentPath)
    }

    const newPending = new Map(get().pendingCollapses)
    newPending.delete(normalized)

    set({
      directoryContents: newContents,
      pendingCollapses: newPending
    })

    for (const dir of pending.dirsToUnwatch) {
      filesystemApi.unwatchDirectory(dir)
    }
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
      suppressTreeAnimations: true,
      expandedDirs: rootPath ? new Set([rootPath]) : new Set<string>(),
      directoryContents: newContents,
      pendingCollapses: new Map<string, PendingDirectoryCollapse>()
    })
    queueMicrotask(() => {
      set({ suppressTreeAnimations: false })
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
  },

  setSearchQuery: (query: string): void => {
    set({ searchQuery: query })
  },

  searchInRoot: async (query: string, requestId: number): Promise<void> => {
    const { rootPath, scopeRoot } = get()
    const searchScopeRoot = scopeRoot ?? rootPath
    if (!rootPath || !searchScopeRoot) {
      set({
        searchLoading: false,
        searchError: 'No project selected',
        searchErrorCode: null,
        searchResults: [],
        searchFileNameMatches: null,
        searchTruncated: false,
        searchScannedFiles: 0,
        searchFailedFiles: 0,
        searchRequestId: requestId
      })
      return
    }

    const trimmed = query.trim()
    if (!trimmed || trimmed.length < 2) {
      const activeRequestId = get().searchRequestId
      if (activeRequestId > 0) {
        filesystemApi.searchContentStreamCancel(`search-${activeRequestId}`).catch((e) => {
          console.warn(
            `[file-explorer] searchContentStreamCancel(search-${activeRequestId}) failed:`,
            e
          )
        })
        filesystemApi.searchFileNamesStreamCancel(`search-${activeRequestId}`).catch((e) => {
          console.warn(
            `[file-explorer] searchFileNamesStreamCancel(search-${activeRequestId}) failed:`,
            e
          )
        })
      }
      set({
        searchLoading: false,
        searchError: null,
        searchErrorCode: null,
        searchResults: [],
        searchFileNameMatches: null,
        searchTruncated: false,
        searchScannedFiles: 0,
        searchFailedFiles: 0,
        searchRequestId: requestId
      })
      return
    }

    ensureSearchStreamSubscription(set, get)
    ensureFileNameStreamSubscription(set, get)

    const activeRequestId = get().searchRequestId
    if (activeRequestId > 0) {
      filesystemApi.searchContentStreamCancel(`search-${activeRequestId}`).catch((e) => {
        console.warn(
          `[file-explorer] searchContentStreamCancel(search-${activeRequestId}) failed:`,
          e
        )
      })
      filesystemApi.searchFileNamesStreamCancel(`search-${activeRequestId}`).catch((e) => {
        console.warn(
          `[file-explorer] searchFileNamesStreamCancel(search-${activeRequestId}) failed:`,
          e
        )
      })
    }

    const { searchLastCompletedQuery, searchResults } = get()
    if (
      searchLastCompletedQuery &&
      trimmed.toLowerCase().startsWith(searchLastCompletedQuery.toLowerCase()) &&
      searchResults.length > 0
    ) {
      const filtered = searchResults
        .map((file) => ({
          ...file,
          matches: file.matches.filter((match) =>
            match.lineText.toLowerCase().includes(trimmed.toLowerCase())
          )
        }))
        .filter((file) => file.matches.length > 0)
      set({
        searchResults: filtered,
        searchFileNameMatches: null,
        searchLoading: true,
        searchError: null,
        searchRequestId: requestId,
        searchTruncated: false,
        searchScannedFiles: 0,
        searchFailedFiles: 0
      })
    } else {
      set({
        searchLoading: true,
        searchError: null,
        searchRequestId: requestId,
        searchResults: [],
        searchFileNameMatches: null,
        searchTruncated: false,
        searchScannedFiles: 0,
        searchFailedFiles: 0
      })
    }

    const streamStartPromise = filesystemApi.searchContentStreamStart(
      `search-${requestId}`,
      searchScopeRoot,
      rootPath,
      trimmed
    )
    const fileNameStreamStartPromise = filesystemApi.searchFileNamesStreamStart(
      `search-${requestId}`,
      searchScopeRoot,
      rootPath,
      trimmed
    )

    const [streamStart, fileNameStreamStart] = await Promise.all([
      streamStartPromise,
      fileNameStreamStartPromise
    ])

    if (get().searchRequestId !== requestId) {
      if (streamStart.success) {
        filesystemApi.searchContentStreamCancel(`search-${requestId}`).catch((e) => {
          console.warn(`[file-explorer] searchContentStreamCancel(search-${requestId}) failed:`, e)
        })
      }
      if (fileNameStreamStart.success) {
        filesystemApi.searchFileNamesStreamCancel(`search-${requestId}`).catch((e) => {
          console.warn(
            `[file-explorer] searchFileNamesStreamCancel(search-${requestId}) failed:`,
            e
          )
        })
      }
      return
    }

    if (!streamStart.success || !fileNameStreamStart.success) {
      if (streamStart.success) {
        filesystemApi.searchContentStreamCancel(`search-${requestId}`).catch((e) => {
          console.warn(`[file-explorer] searchContentStreamCancel(search-${requestId}) failed:`, e)
        })
      }
      if (fileNameStreamStart.success) {
        filesystemApi.searchFileNamesStreamCancel(`search-${requestId}`).catch((e) => {
          console.warn(
            `[file-explorer] searchFileNamesStreamCancel(search-${requestId}) failed:`,
            e
          )
        })
      }
      const error = !streamStart.success
        ? streamStart.error
        : !fileNameStreamStart.success
          ? fileNameStreamStart.error
          : 'Search failed'
      set({
        searchLoading: false,
        searchError: error,
        searchResults: [],
        searchFileNameMatches: null,
        searchTruncated: false,
        searchScannedFiles: 0,
        searchFailedFiles: 0
      })
    }
  },

  resetSearch: (): void => {
    const activeRequestId = get().searchRequestId
    if (activeRequestId > 0) {
      filesystemApi.searchContentStreamCancel(`search-${activeRequestId}`).catch((e) => {
        console.warn(
          `[file-explorer] searchContentStreamCancel(search-${activeRequestId}) failed:`,
          e
        )
      })
      filesystemApi.searchFileNamesStreamCancel(`search-${activeRequestId}`).catch((e) => {
        console.warn(
          `[file-explorer] searchFileNamesStreamCancel(search-${activeRequestId}) failed:`,
          e
        )
      })
    }
    // Set filename matches to an empty list synchronously: the tab is hidden
    // while no search is active, but leaving a stale `null` here means a
    // consumer reading the state sees a lie. The next searchInRoot call will
    // re-seed `null` if it actually starts a new stream.
    set({
      searchQuery: '',
      searchResults: [],
      searchFileNameMatches: [],
      searchLoading: false,
      searchError: null,
      searchErrorCode: null,
      searchTruncated: false,
      searchScannedFiles: 0,
      searchFailedFiles: 0,
      searchRequestId: 0,
      searchLastCompletedQuery: ''
    })
  }
}))

// Selector hooks
export function useFileExplorer(): Pick<
  FileExplorerState,
  | 'rootPath'
  | 'expandedDirs'
  | 'directoryContents'
  | 'selectedPaths'
  | 'lastClickedPath'
  | 'clipboard'
  | 'isVisible'
  | 'loadingDirs'
  | 'rootLoadError'
  | 'searchQuery'
  | 'searchResults'
  | 'searchFileNameMatches'
  | 'searchLoading'
  | 'searchError'
  | 'searchTruncated'
  | 'searchScannedFiles'
  | 'searchFailedFiles'
  | 'searchLastCompletedQuery'
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
      rootLoadError: state.rootLoadError,
      searchQuery: state.searchQuery,
      searchResults: state.searchResults,
      searchFileNameMatches: state.searchFileNameMatches,
      searchLoading: state.searchLoading,
      searchError: state.searchError,
      searchTruncated: state.searchTruncated,
      searchScannedFiles: state.searchScannedFiles,
      searchFailedFiles: state.searchFailedFiles,
      searchLastCompletedQuery: state.searchLastCompletedQuery
    }))
  )
}

export function useFileExplorerActions(): Pick<
  FileExplorerState,
  | 'setRootPath'
  | 'setWorktreeRoot'
  | 'toggleDirectory'
  | 'finalizeDirectoryCollapse'
  | 'refreshDirectory'
  | 'refreshTree'
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
  | 'setSearchQuery'
  | 'searchInRoot'
  | 'resetSearch'
> {
  return useFileExplorerStore(
    useShallow((state) => ({
      setRootPath: state.setRootPath,
      setWorktreeRoot: state.setWorktreeRoot,
      toggleDirectory: state.toggleDirectory,
      finalizeDirectoryCollapse: state.finalizeDirectoryCollapse,
      refreshDirectory: state.refreshDirectory,
      refreshTree: state.refreshTree,
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
      restoreExpandedDirs: state.restoreExpandedDirs,
      setSearchQuery: state.setSearchQuery,
      searchInRoot: state.searchInRoot,
      resetSearch: state.resetSearch
    }))
  )
}

export function useFileExplorerVisible(): boolean {
  return useFileExplorerStore((state) => state.isVisible)
}
