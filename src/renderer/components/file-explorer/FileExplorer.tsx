import type { DirectoryEntry } from '@shared/types/filesystem.types'
import { ChevronsDownUp, LoaderCircle, Search, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { clipboardApi, filesystemApi, openerApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useEditorStore } from '@/stores/editor-store'
import {
  useFileExplorer,
  useFileExplorerActions,
  useFileExplorerStore
} from '@/stores/file-explorer-store'
import { useProjectStore } from '@/stores/project-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { editorTabId, useWorkspaceStore } from '@/stores/workspace-store'
import { FileTreeContextMenu } from './FileTreeContextMenu'
import { FileTreeNodeWrapper } from './FileTreeNode'

interface ContextMenuState {
  x: number
  y: number
  entry: DirectoryEntry
}

interface InlineInputState {
  parentPath: string
  type: 'file' | 'folder'
  mode: 'create' | 'rename'
  existingEntry?: DirectoryEntry
}

interface FileExplorerProps {
  side?: 'left' | 'right'
}

export function FileExplorer({ side = 'right' }: FileExplorerProps): React.JSX.Element {
  const {
    rootPath,
    directoryContents,
    isVisible,
    rootLoadError,
    selectedPaths,
    clipboard,
    searchQuery,
    searchResults,
    searchFileNameMatches,
    searchLoading,
    searchError,
    searchTruncated,
    searchScannedFiles,
    searchFailedFiles,
    searchLastCompletedQuery
  } = useFileExplorer()
  const {
    toggleDirectory,
    selectPath,
    togglePathSelection,
    selectPathRange,
    selectAll,
    clearSelection,
    copySelected,
    cutSelected,
    paste,
    duplicateSelected,
    collapseAll,
    refreshDirectory,
    setRootLoadError,
    setSearchQuery,
    searchInRoot,
    resetSearch
  } = useFileExplorerActions()

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [inlineInput, setInlineInput] = useState<InlineInputState | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState<DirectoryEntry | null>(null)
  const [searchResultTab, setSearchResultTab] = useState<'content' | 'files'>('content')
  const [expandedSearchResultPaths, setExpandedSearchResultPaths] = useState<Set<string>>(new Set())
  const [explorerWidth, setExplorerWidth] = useState(() => {
    try {
      const savedWidth = window.localStorage?.getItem('termul:file-explorer-width')
      if (!savedWidth) return 256
      const parsed = Number.parseInt(savedWidth, 10)
      if (Number.isNaN(parsed)) return 256
      return Math.max(220, Math.min(560, parsed))
    } catch {
      return 256
    }
  })
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const searchDebounceRef = useRef<number | null>(null)
  const searchRequestIdRef = useRef(0)
  const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const resizeCleanupRef = useRef<(() => void) | null>(null)
  const userSelectedTabRef = useRef(false)

  const rootEntries = rootPath ? directoryContents.get(rootPath) : undefined
  const normalizedSearchQuery = searchQuery ?? ''
  const safeSearchResults = searchResults ?? []
  const safeSearchFileNameMatches = searchFileNameMatches ?? []
  const fileNameMatchesPending = searchFileNameMatches === null
  const hasSearchInput = normalizedSearchQuery.length > 0
  const trimmedSearchQuery = normalizedSearchQuery.trim()
  const isSearchActive = trimmedSearchQuery.length > 0
  const isSearchTooShort = isSearchActive && trimmedSearchQuery.length < 2
  const hasContentResults = safeSearchResults.length > 0
  const hasFileResults = safeSearchFileNameMatches.length > 0
  const hasAnySearchResults = hasContentResults || hasFileResults
  const hasPartialSearchError = Boolean(searchError) && hasAnySearchResults
  const _totalContentMatches = safeSearchResults.reduce(
    (total, fileResult) => total + fileResult.matches.length,
    0
  )
  const resultsAreCurrent = searchLastCompletedQuery === trimmedSearchQuery
  const showSearchEmptyState =
    trimmedSearchQuery.length >= 2 &&
    resultsAreCurrent &&
    !searchLoading &&
    !searchError &&
    !hasAnySearchResults

  useEffect(() => {
    userSelectedTabRef.current = false
  }, [])

  useEffect(() => {
    if (userSelectedTabRef.current) {
      return
    }
    if (
      searchResultTab === 'content' &&
      safeSearchResults.length === 0 &&
      safeSearchFileNameMatches.length > 0 &&
      !searchLoading
    ) {
      setSearchResultTab('files')
      return
    }
    if (
      searchResultTab === 'files' &&
      safeSearchFileNameMatches.length === 0 &&
      safeSearchResults.length > 0 &&
      !searchLoading
    ) {
      setSearchResultTab('content')
    }
  }, [safeSearchFileNameMatches.length, searchResultTab, safeSearchResults.length, searchLoading])

  useEffect(() => {
    try {
      window.localStorage?.setItem('termul:file-explorer-width', String(explorerWidth))
    } catch {
      // Ignore localStorage access failures in restricted environments.
    }
  }, [explorerWidth])

  const finalizeResizeDrag = useCallback(() => {
    resizeStateRef.current = null
    document.body.style.userSelect = ''
    if (resizeCleanupRef.current) {
      resizeCleanupRef.current()
      resizeCleanupRef.current = null
    }
  }, [])

  const applyResizedWidth = useCallback((rawWidth: number) => {
    const nextWidth = Math.max(220, Math.min(560, rawWidth))
    setExplorerWidth(nextWidth)
  }, [])

  const handleResizeMouseDown = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      document.body.style.userSelect = 'none'
      resizeStateRef.current = { startX: event.clientX, startWidth: explorerWidth }

      const onMouseMove = (moveEvent: MouseEvent) => {
        const state = resizeStateRef.current
        if (!state) return
        const delta = moveEvent.clientX - state.startX
        const rawWidth = side === 'right' ? state.startWidth - delta : state.startWidth + delta
        applyResizedWidth(rawWidth)
      }

      const onMouseUp = () => {
        finalizeResizeDrag()
      }

      const onWindowBlur = () => {
        finalizeResizeDrag()
      }

      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
      window.addEventListener('blur', onWindowBlur)
      resizeCleanupRef.current = () => {
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        window.removeEventListener('blur', onWindowBlur)
      }
    },
    [applyResizedWidth, explorerWidth, finalizeResizeDrag, side]
  )

  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (
        event.key !== 'ArrowLeft' &&
        event.key !== 'ArrowRight' &&
        event.key !== 'Home' &&
        event.key !== 'End'
      ) {
        return
      }
      event.preventDefault()
      const step = 16
      if (event.key === 'Home') {
        applyResizedWidth(220)
        return
      }
      if (event.key === 'End') {
        applyResizedWidth(560)
        return
      }
      const directionalDelta = event.key === 'ArrowLeft' ? -step : step
      const signedDelta = side === 'right' ? -directionalDelta : directionalDelta
      applyResizedWidth(explorerWidth + signedDelta)
    },
    [applyResizedWidth, explorerWidth, side]
  )

  // Auto-expand root directory on mount
  useEffect(() => {
    if (rootPath && !directoryContents.has(rootPath) && !rootLoadError) {
      toggleDirectory(rootPath)
    }
  }, [rootPath, directoryContents, rootLoadError, toggleDirectory])

  useEffect(() => {
    resetSearch()
    setExpandedSearchResultPaths(new Set())
  }, [resetSearch])

  useEffect(() => {
    setExpandedSearchResultPaths(new Set())
  }, [])

  useEffect(() => {
    if (searchDebounceRef.current !== null) {
      window.clearTimeout(searchDebounceRef.current)
    }

    if (!rootPath) {
      return
    }

    searchDebounceRef.current = window.setTimeout(
      () => {
        searchRequestIdRef.current += 1
        void searchInRoot(normalizedSearchQuery, searchRequestIdRef.current)
      },
      trimmedSearchQuery.length >= 3 ? 90 : 180
    )

    return () => {
      if (searchDebounceRef.current !== null) {
        window.clearTimeout(searchDebounceRef.current)
      }
    }
  }, [rootPath, normalizedSearchQuery, searchInRoot, trimmedSearchQuery.length])

  useEffect(() => {
    return () => {
      finalizeResizeDrag()
    }
  }, [finalizeResizeDrag])

  // Focus inline input when it appears
  useEffect(() => {
    if (inlineInput && inputRef.current) {
      inputRef.current.focus()
      if (inlineInput.mode === 'rename' && inlineInput.existingEntry) {
        // Select the name without extension for files
        const name = inlineInput.existingEntry.name
        if (inlineInput.existingEntry.type === 'file') {
          const dotIndex = name.lastIndexOf('.')
          if (dotIndex > 0) {
            inputRef.current.setSelectionRange(0, dotIndex)
          } else {
            inputRef.current.select()
          }
        } else {
          inputRef.current.select()
        }
      }
    }
  }, [inlineInput])

  const handleSelect = useCallback(
    async (path: string) => {
      selectPath(path)
      try {
        await useEditorStore.getState().openFile(path)
        useWorkspaceStore.getState().addEditorTab(path)
      } catch {
        // File couldn't be opened (binary, too large, etc.)
      }
    },
    [selectPath]
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, entry: DirectoryEntry) => {
      e.preventDefault()
      e.stopPropagation()
      // If right-clicking on an unselected item, select only that item
      // If right-clicking on a selected item, keep the current selection
      if (!selectedPaths.has(entry.path)) {
        selectPath(entry.path)
      }
      setContextMenu({ x: e.clientX, y: e.clientY, entry })
    },
    [selectPath, selectedPaths]
  )

  // Handle multi-select clicks
  const handleNodeClick = useCallback(
    (e: React.MouseEvent, entry: DirectoryEntry) => {
      const lastClickedPath = useFileExplorerStore.getState().lastClickedPath

      if (e.ctrlKey || e.metaKey) {
        // Ctrl+Click: Toggle selection
        togglePathSelection(entry.path)
      } else if (e.shiftKey && lastClickedPath) {
        // Shift+Click: Range selection
        selectPathRange(lastClickedPath, entry.path)
      } else {
        // Normal click: Single selection (and toggle directory if it's a directory)
        if (entry.type === 'directory') {
          toggleDirectory(entry.path)
        } else {
          selectPath(entry.path)
          handleSelect(entry.path)
        }
      }
    },
    [togglePathSelection, selectPathRange, selectPath, toggleDirectory, handleSelect]
  )

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle shortcuts when file explorer is focused
      if (
        !containerRef.current?.contains(document.activeElement) &&
        document.activeElement !== document.body
      ) {
        return
      }

      // Don't handle shortcuts when typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return
      }

      // Ctrl+A: Select all
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault()
        selectAll()
        return
      }

      // Ctrl+C: Copy
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        e.preventDefault()
        copySelected()
        return
      }

      // Ctrl+X: Cut
      if ((e.ctrlKey || e.metaKey) && e.key === 'x') {
        e.preventDefault()
        cutSelected()
        return
      }

      // Ctrl+V: Paste
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        e.preventDefault()
        let targetPath: string | undefined
        if (contextMenu?.entry) {
          targetPath = contextMenu.entry.path
        } else if (selectedPaths.size === 1) {
          const [selectedPath] = [...selectedPaths]
          let isDirectory = false
          outer: for (const [, entries] of directoryContents) {
            for (const entry of entries) {
              if (entry.path === selectedPath && entry.type === 'directory') {
                isDirectory = true
                break outer
              }
            }
          }
          if (isDirectory) {
            targetPath = selectedPath
          } else {
            const normalized = selectedPath.replace(/\\/g, '/')
            const lastSlash = normalized.lastIndexOf('/')
            targetPath = lastSlash > 0 ? normalized.slice(0, lastSlash) : (rootPath ?? '')
          }
        }
        if (!targetPath && rootPath) {
          targetPath = rootPath
        }
        if (targetPath) {
          void paste(targetPath)
        }
        return
      }

      // F2: Rename
      if (e.key === 'F2' && selectedPaths.size === 1) {
        e.preventDefault()
        const [path] = selectedPaths
        const normalizedPath = path.replace(/\\/g, '/')
        const lastSlash = normalizedPath.lastIndexOf('/')
        const parentPath =
          lastSlash > 0 ? normalizedPath.slice(0, lastSlash) : lastSlash === 0 ? '/' : ''
        // Find the entry for this path
        for (const [, entries] of directoryContents) {
          const entry = entries.find((e) => e.path === path)
          if (entry) {
            setInlineInput({
              parentPath,
              type: entry.type === 'directory' ? 'folder' : 'file',
              mode: 'rename',
              existingEntry: entry
            })
            setInputValue(entry.name)
            break
          }
        }
        return
      }

      // Delete: Move to trash (for now, permanent delete)
      if (e.key === 'Delete' && selectedPaths.size > 0) {
        e.preventDefault()
        // For now, delete the first selected item with confirmation
        // TODO: Implement batch delete with multi-select
        const [path] = selectedPaths
        for (const [, entries] of directoryContents) {
          const entry = entries.find((e) => e.path === path)
          if (entry) {
            setDeleteConfirm(entry)
            break
          }
        }
        return
      }

      // Escape: Clear selection
      if (e.key === 'Escape') {
        clearSelection()
        setContextMenu(null)
        return
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [
    selectAll,
    copySelected,
    cutSelected,
    paste,
    selectedPaths,
    directoryContents,
    contextMenu,
    clearSelection,
    rootPath
  ])

  const handleNewFile = useCallback((dirPath: string) => {
    setContextMenu(null)
    setInlineInput({ parentPath: dirPath, type: 'file', mode: 'create' })
    setInputValue('')
  }, [])

  const handleNewFolder = useCallback((dirPath: string) => {
    setContextMenu(null)
    setInlineInput({ parentPath: dirPath, type: 'folder', mode: 'create' })
    setInputValue('')
  }, [])

  const handleRename = useCallback((entry: DirectoryEntry) => {
    setContextMenu(null)
    const normalizedPath = entry.path.replace(/\\/g, '/')
    const lastSlash = normalizedPath.lastIndexOf('/')
    const parentPath =
      lastSlash > 0 ? normalizedPath.slice(0, lastSlash) : lastSlash === 0 ? '/' : ''
    setInlineInput({
      parentPath,
      type: entry.type === 'directory' ? 'folder' : 'file',
      mode: 'rename',
      existingEntry: entry
    })
    setInputValue(entry.name)
  }, [])

  const handleDelete = useCallback((entry: DirectoryEntry) => {
    setContextMenu(null)
    setDeleteConfirm(entry)
  }, [])

  const handleCopyPath = useCallback((path: string) => {
    setContextMenu(null)
    void clipboardApi.writeText(path)
  }, [])

  const isSubmittingRef = useRef(false)
  const submitFailedRef = useRef(false)

  const handleInlineInputSubmit = useCallback(async () => {
    if (isSubmittingRef.current) return
    isSubmittingRef.current = true
    submitFailedRef.current = false

    if (!inlineInput || !inputValue.trim()) {
      setInlineInput(null)
      isSubmittingRef.current = false
      return
    }

    const name = inputValue.trim()
    const fullPath = `${inlineInput.parentPath}/${name}`

    try {
      let result: { success: boolean; error?: string } | undefined
      if (inlineInput.mode === 'create') {
        if (inlineInput.type === 'file') {
          result = await filesystemApi.createFile(fullPath)
        } else {
          result = await filesystemApi.createDirectory(fullPath)
        }
      } else if (inlineInput.mode === 'rename' && inlineInput.existingEntry) {
        result = await filesystemApi.renameFile(inlineInput.existingEntry.path, fullPath)
      }

      if (!result?.success) {
        toast.error(result?.error || 'Operation failed')
        submitFailedRef.current = true
        return
      }

      // Success side-effects
      if (inlineInput.mode === 'rename' && inlineInput.existingEntry) {
        // If the renamed file was open in editor, close old tab
        const editorState = useEditorStore.getState()
        if (editorState.openFiles.has(inlineInput.existingEntry.path)) {
          editorState.closeFile(inlineInput.existingEntry.path)
          useWorkspaceStore.getState().removeTab(editorTabId(inlineInput.existingEntry.path))
        }
      }
      await refreshDirectory(inlineInput.parentPath)
      setInlineInput(null)
      setInputValue('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Unknown error')
      submitFailedRef.current = true
    } finally {
      isSubmittingRef.current = false
    }
  }, [inlineInput, inputValue, refreshDirectory])

  const handleInlineInputCancel = useCallback(() => {
    if (isSubmittingRef.current) return
    if (submitFailedRef.current) {
      submitFailedRef.current = false
      return
    }
    setInlineInput(null)
    setInputValue('')
  }, [])

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteConfirm) return

    const isDir = deleteConfirm.type === 'directory'
    const result = await filesystemApi.deletePath(deleteConfirm.path, {
      recursive: isDir
    })

    if (!result.success) {
      toast.error(`Failed to delete ${deleteConfirm.path}: ${result.error}`)
      return
    }

    const normalizedDeletePath = deleteConfirm.path.replace(/\\/g, '/')

    // If deleting a directory, clean up expanded dirs, cached contents,
    // and any open editor tabs for files inside the deleted directory
    if (isDir) {
      const store = useFileExplorerStore.getState()
      const newExpanded = new Set(store.expandedDirs)
      const newContents = new Map(store.directoryContents)

      // Close editor tabs for files inside the deleted directory
      const editorState = useEditorStore.getState()
      const workspaceState = useWorkspaceStore.getState()
      for (const [openFilePath] of editorState.openFiles) {
        const normalizedOpenPath = openFilePath.replace(/\\/g, '/')
        if (
          normalizedOpenPath === normalizedDeletePath ||
          normalizedOpenPath.startsWith(`${normalizedDeletePath}/`)
        ) {
          editorState.closeFile(openFilePath)
          workspaceState.removeTab(editorTabId(openFilePath))
        }
      }

      // Remove all cached directories and expanded dirs that are children of the deleted dir
      for (const key of newContents.keys()) {
        if (key.startsWith(`${normalizedDeletePath}/`) || key === normalizedDeletePath) {
          newExpanded.delete(key)
          newContents.delete(key)
          void filesystemApi.unwatchDirectory(key)
        }
      }

      useFileExplorerStore.setState({
        expandedDirs: newExpanded,
        directoryContents: newContents
      })
    } else {
      // Close editor tab if file was open
      const editorState = useEditorStore.getState()
      if (editorState.openFiles.has(deleteConfirm.path)) {
        editorState.closeFile(deleteConfirm.path)
        useWorkspaceStore.getState().removeTab(editorTabId(deleteConfirm.path))
      }
    }

    const parentPath = normalizedDeletePath.substring(0, normalizedDeletePath.lastIndexOf('/'))
    // Clear selection if the deleted item was selected
    useFileExplorerStore.getState().clearSelection()
    await refreshDirectory(parentPath)
    setDeleteConfirm(null)
  }, [deleteConfirm, refreshDirectory])

  const handleSearchMatchClick = useCallback(
    async (filePath: string, lineNumber: number) => {
      const searchTerm = searchLastCompletedQuery.trim()
      selectPath(filePath)
      try {
        await useEditorStore.getState().openFile(filePath)
        useWorkspaceStore.getState().addEditorTab(filePath)
        const isMarkdown = /\.md$/i.test(filePath)
        if (isMarkdown) {
          useEditorStore.getState().setViewMode(filePath, 'code')
        }
        useEditorStore.getState().updateCursorPosition(filePath, lineNumber, 1)
        const revealDetail = { filePath, lineNumber, searchTerm }
        ;(
          window as unknown as { __termulPendingRevealLine?: typeof revealDetail }
        ).__termulPendingRevealLine = revealDetail
        window.dispatchEvent(
          new CustomEvent('termul:reveal-line', {
            detail: revealDetail
          })
        )
        requestAnimationFrame(() => {
          window.dispatchEvent(
            new CustomEvent('termul:reveal-line', {
              detail: revealDetail
            })
          )
        })
      } catch {
        toast.warning('File opened, but failed to focus target line')
      }
    },
    [searchLastCompletedQuery, selectPath]
  )

  const handleRootRetry = useCallback(() => {
    if (!rootPath) return
    setRootLoadError(null)
    void toggleDirectory(rootPath)
  }, [rootPath, setRootLoadError, toggleDirectory])

  const toggleExpandedSearchResult = useCallback((filePath: string) => {
    setExpandedSearchResultPaths((current) => {
      const next = new Set(current)
      if (next.has(filePath)) {
        next.delete(filePath)
      } else {
        next.add(filePath)
      }
      return next
    })
  }, [])

  const getFileLabel = useCallback(
    (filePath: string) => {
      const normalizedFilePath = filePath.replace(/\\/g, '/')
      const normalizedRootPath = (rootPath ?? '').replace(/\\/g, '/')
      const fileName = normalizedFilePath.split('/').pop() ?? normalizedFilePath
      const relativePath = normalizedRootPath
        ? normalizedFilePath.replace(`${normalizedRootPath}/`, '')
        : normalizedFilePath
      const folderPath = relativePath.includes('/')
        ? relativePath.slice(0, relativePath.lastIndexOf('/'))
        : ''

      return { fileName, folderPath, relativePath }
    },
    [rootPath]
  )

  const renderHighlightedLine = useCallback(
    (lineText: string) => {
      const query = normalizedSearchQuery.trim()
      if (!query) return lineText

      const lowerLine = lineText.toLowerCase()
      const lowerQuery = query.toLowerCase()
      const parts: React.ReactNode[] = []
      let startIndex = 0
      let matchIndex = lowerLine.indexOf(lowerQuery, startIndex)

      while (matchIndex !== -1) {
        if (matchIndex > startIndex) {
          parts.push(lineText.slice(startIndex, matchIndex))
        }

        parts.push(
          <span
            key={`${matchIndex}-${matchIndex + query.length}`}
            className="rounded-sm border border-primary/35 bg-primary/20 px-0.5 text-foreground transition-colors group-hover:bg-primary/25 group-focus-visible:bg-primary/30"
          >
            {lineText.slice(matchIndex, matchIndex + query.length)}
          </span>
        )

        startIndex = matchIndex + query.length
        matchIndex = lowerLine.indexOf(lowerQuery, startIndex)
      }

      if (startIndex < lineText.length) {
        parts.push(lineText.slice(startIndex))
      }

      return parts.length > 0 ? parts : lineText
    },
    [normalizedSearchQuery]
  )

  // Open terminal in directory
  const handleOpenInTerminal = useCallback((dirPath: string) => {
    setContextMenu(null)
    const activeProjectId = useProjectStore.getState().activeProjectId
    if (!activeProjectId) {
      toast.error('No active project')
      return
    }

    const terminalStore = useTerminalStore.getState()
    try {
      terminalStore.addTerminal('Terminal', activeProjectId, 'powershell', dirPath)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to open terminal'
      toast.error(message)
    }
  }, [])

  // Open with external app
  const handleOpenWithExternal = useCallback(async (filePath: string) => {
    setContextMenu(null)
    const result = await openerApi.openWithExternalApp(filePath)
    if (!result.success) {
      toast.error(`Failed to open file: ${result.error}`)
    }
  }, [])

  // Show in file manager
  const handleShowInFileManager = useCallback(async (path: string) => {
    setContextMenu(null)
    const result = await openerApi.revealInFileManager(path)
    if (!result.success) {
      toast.error(`Failed to reveal in file manager: ${result.error}`)
    }
  }, [])

  // Copy handler
  const handleCopy = useCallback(() => {
    setContextMenu(null)
    copySelected()
  }, [copySelected])

  // Cut handler
  const handleCut = useCallback(() => {
    setContextMenu(null)
    cutSelected()
  }, [cutSelected])

  // Paste handler
  const handlePaste = useCallback(
    async (destinationPath: string) => {
      setContextMenu(null)
      await paste(destinationPath)
    },
    [paste]
  )

  // Duplicate handler
  const handleDuplicate = useCallback(async () => {
    setContextMenu(null)
    await duplicateSelected()
  }, [duplicateSelected])

  if (!isVisible) return <></>

  return (
    <div
      id="file-explorer-panel"
      ref={containerRef}
      className="relative flex flex-col bg-background text-foreground rounded-xl flex-shrink-0 h-full"
      style={{ width: explorerWidth }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-10 border-b border-border flex-shrink-0 rounded-t-xl">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Explorer
        </span>
        <button
          onClick={collapseAll}
          className="text-muted-foreground hover:text-foreground transition-colors p-0.5"
          title="Collapse All"
        >
          <ChevronsDownUp size={14} />
        </button>
      </div>

      <div className="px-3 py-1.5 border-b border-border">
        <div className="relative">
          <Search
            size={13}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="text"
            value={normalizedSearchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search files and content…"
            className="w-full rounded-none border-0 bg-transparent py-1 pl-7 pr-7 text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:ring-0"
            aria-label="Search files and content"
          />
          {hasSearchInput && (
            <button
              onClick={() => resetSearch()}
              className="absolute right-0 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus:outline-none"
              title="Clear search"
              aria-label="Clear search"
            >
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      {/* Tree / Search Results */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden py-1">
        {!rootPath && (
          <div className="px-3 py-4 text-sm text-muted-foreground">No project selected</div>
        )}

        {rootPath && rootLoadError && (
          <div className="px-3 py-4 space-y-2">
            <p className="text-sm text-red-400">Failed to load project files.</p>
            <p className="text-xs text-muted-foreground break-words">{rootLoadError.message}</p>
            <button
              onClick={handleRootRetry}
              className="px-2 py-1 text-xs rounded bg-secondary text-foreground hover:bg-secondary/80"
            >
              Retry
            </button>
          </div>
        )}

        {rootPath && !rootEntries && !rootLoadError && (
          <div className="px-3 py-4 text-sm text-muted-foreground">Loading...</div>
        )}

        {rootPath &&
          rootEntries &&
          !rootLoadError &&
          (!isSearchActive ||
            isSearchTooShort ||
            (searchLoading && searchLastCompletedQuery !== trimmedSearchQuery)) &&
          rootEntries.map((entry) => (
            <FileTreeNodeWrapper
              key={entry.path}
              entry={entry}
              depth={0}
              onToggle={toggleDirectory}
              onSelect={handleSelect}
              onContextMenu={handleContextMenu}
              onClick={handleNodeClick}
            />
          ))}

        {rootPath && !rootLoadError && isSearchActive && (
          <div className="space-y-1.5 px-2 py-1.5">
            {(searchLoading ||
              searchError ||
              isSearchTooShort ||
              showSearchEmptyState ||
              !resultsAreCurrent) && (
              <div className="rounded-md border border-border/70 bg-background/60 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
                <p className="text-[10px] font-medium text-foreground">
                  {searchLoading
                    ? `Searching for “${trimmedSearchQuery}”…`
                    : hasPartialSearchError
                      ? `Partial results for “${trimmedSearchQuery}”`
                      : searchError
                        ? 'Search unavailable'
                        : isSearchTooShort
                          ? 'Keep typing to start searching'
                          : showSearchEmptyState
                            ? `No matches for “${trimmedSearchQuery}”`
                            : `Updating results for “${trimmedSearchQuery}”…`}
                </p>
                <p className="mt-0.5">
                  {hasPartialSearchError
                    ? `${searchError} Showing the matches that were found before the search stopped.`
                    : searchError
                      ? searchError
                      : isSearchTooShort
                        ? 'Type at least 2 characters to search file names and content.'
                        : showSearchEmptyState
                          ? 'Try a different term or a shorter phrase to broaden the search.'
                          : 'Finishing the latest search before showing refreshed matches.'}
                </p>
              </div>
            )}

            {(searchTruncated || searchFailedFiles > 0) && (
              <div className="rounded-md border border-border/70 bg-background/60 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
                {searchTruncated
                  ? 'Results were truncated for performance.'
                  : 'Some files could not be fully searched.'}
                {searchFailedFiles > 0
                  ? ` ${searchFailedFiles} file${searchFailedFiles === 1 ? ' was' : 's were'} skipped.`
                  : ''}
                {searchScannedFiles > 0
                  ? ` Scanned ${searchScannedFiles} file${searchScannedFiles === 1 ? '' : 's'}.`
                  : ''}
              </div>
            )}

            {hasAnySearchResults && (
              <div className="rounded-lg border border-border/70 bg-card/25 p-1 shadow-sm">
                <div
                  className="grid grid-cols-2 gap-1"
                  role="tablist"
                  aria-label="Search result types"
                >
                  <button
                    onClick={() => {
                      userSelectedTabRef.current = true
                      setSearchResultTab('content')
                    }}
                    className={cn(
                      'flex items-center justify-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium transition-colors',
                      searchResultTab === 'content'
                        ? 'bg-secondary text-foreground shadow-sm'
                        : 'text-muted-foreground hover:bg-background/70 hover:text-foreground'
                    )}
                    type="button"
                    role="tab"
                    aria-selected={searchResultTab === 'content'}
                  >
                    {searchLoading && <LoaderCircle size={10} className="animate-spin" />}
                    Content{' '}
                    <span className="text-muted-foreground">{safeSearchResults.length}</span>
                  </button>
                  <button
                    onClick={() => {
                      userSelectedTabRef.current = true
                      setSearchResultTab('files')
                    }}
                    className={cn(
                      'flex items-center justify-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium transition-colors',
                      searchResultTab === 'files'
                        ? 'bg-secondary text-foreground shadow-sm'
                        : 'text-muted-foreground hover:bg-background/70 hover:text-foreground'
                    )}
                    type="button"
                    role="tab"
                    aria-selected={searchResultTab === 'files'}
                  >
                    {searchLoading && <LoaderCircle size={10} className="animate-spin" />}
                    Files{' '}
                    <span className="text-muted-foreground">
                      {fileNameMatchesPending ? "…" : safeSearchFileNameMatches.length}
                    </span>
                  </button>
                </div>
              </div>
            )}

            {searchResultTab === 'files' && hasFileResults && (
              <div className="space-y-1">
                {safeSearchFileNameMatches.map((filePath) => {
                  const { fileName, relativePath } = getFileLabel(filePath)
                  return (
                    <button
                      key={`fname:${filePath}`}
                      onClick={() => void handleSearchMatchClick(filePath, 1)}
                      className="w-full px-2 py-1.5 text-left transition-colors hover:bg-secondary/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                      title={filePath}
                    >
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <span className="truncate text-[11px] font-medium text-foreground">
                            {fileName}
                          </span>
                          <span className="ml-1.5 truncate text-[10px] text-muted-foreground">
                            {relativePath}
                          </span>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}

            {searchResultTab === 'content' && hasContentResults && (
              <div className="space-y-1">
                {safeSearchResults.map((fileResult) => {
                  const { fileName, relativePath } = getFileLabel(fileResult.filePath)
                  const isExpanded = expandedSearchResultPaths.has(fileResult.filePath)
                  const visibleMatches = isExpanded
                    ? fileResult.matches
                    : fileResult.matches.slice(0, 3)
                  const hiddenCount = Math.max(fileResult.matches.length - visibleMatches.length, 0)
                  return (
                    <div key={fileResult.filePath}>
                      <button
                        onClick={() =>
                          void handleSearchMatchClick(
                            fileResult.filePath,
                            fileResult.matches[0]?.lineNumber ?? 1
                          )
                        }
                        className="w-full px-2 py-1.5 text-left transition-colors hover:bg-secondary/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                        title={fileResult.filePath}
                      >
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <span className="truncate text-[11px] font-medium text-foreground">
                              {fileName}
                            </span>
                            <span className="ml-1.5 truncate text-[10px] text-muted-foreground">
                              {relativePath}
                            </span>
                          </div>
                          <span className="shrink-0 text-[9px] text-muted-foreground">
                            {fileResult.matches.length} hit
                            {fileResult.matches.length === 1 ? '' : 's'}
                          </span>
                        </div>
                      </button>
                      <div className="space-y-0.5 pb-1">
                        {visibleMatches.map((match, idx) => (
                          <button
                            key={`${fileResult.filePath}:${match.lineNumber}:${idx}`}
                            onClick={() =>
                              void handleSearchMatchClick(fileResult.filePath, match.lineNumber)
                            }
                            className="group flex w-full items-center gap-2 overflow-hidden px-2 py-0.5 text-left text-[10px] text-foreground transition-colors hover:bg-secondary/50 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                          >
                            <span className="shrink-0 min-w-[22px] text-right text-[9px] text-muted-foreground">
                              {match.lineNumber}
                            </span>
                            <span className="block min-w-0 flex-1 truncate text-foreground/90">
                              {renderHighlightedLine(match.lineText)}
                            </span>
                          </button>
                        ))}
                        {hiddenCount > 0 && (
                          <button
                            type="button"
                            onClick={() => toggleExpandedSearchResult(fileResult.filePath)}
                            className="px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground focus:outline-none"
                          >
                            Show {hiddenCount} more
                          </button>
                        )}
                        {isExpanded && fileResult.matches.length > 3 && (
                          <button
                            type="button"
                            onClick={() => toggleExpandedSearchResult(fileResult.filePath)}
                            className="px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground focus:outline-none"
                          >
                            Show less
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Inline input for new file/folder/rename */}
        {inlineInput && (
          <div className="flex items-center px-2 py-0.5" style={{ paddingLeft: 20 }}>
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void handleInlineInputSubmit().catch((error) => {
                    console.error('Inline input submit failed:', error)
                  })
                } else if (e.key === 'Escape') {
                  handleInlineInputCancel()
                }
              }}
              onBlur={handleInlineInputCancel}
              className="flex-1 bg-input border border-primary rounded px-1.5 py-0.5 text-sm text-foreground outline-none"
              placeholder={
                inlineInput.mode === 'create'
                  ? inlineInput.type === 'file'
                    ? 'File name...'
                    : 'Folder name...'
                  : 'New name...'
              }
            />
          </div>
        )}
      </div>

      <button
        type="button"
        onMouseDown={handleResizeMouseDown}
        onKeyDown={handleResizeKeyDown}
        className={`absolute ${side === 'right' ? 'left-0' : 'right-0'} top-0 h-full w-1 cursor-col-resize bg-transparent hover:bg-primary/20`}
        title="Drag to resize explorer"
        aria-label="Resize file explorer"
        role="separator"
        aria-controls="file-explorer-panel"
        aria-valuenow={explorerWidth}
        aria-valuemin={220}
        aria-valuemax={560}
      />

      {/* Context Menu */}
      {contextMenu && (
        <FileTreeContextMenu
          entry={contextMenu.entry}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onNewFile={handleNewFile}
          onNewFolder={handleNewFolder}
          onRename={handleRename}
          onDelete={handleDelete}
          onCopyPath={handleCopyPath}
          onCopy={handleCopy}
          onCut={handleCut}
          onPaste={handlePaste}
          onDuplicate={handleDuplicate}
          onOpenInTerminal={handleOpenInTerminal}
          onOpenWithExternal={handleOpenWithExternal}
          onShowInFileManager={handleShowInFileManager}
          selectedCount={selectedPaths.size}
          hasClipboardContent={clipboard !== null}
        />
      )}

      {/* Delete Confirmation Dialog */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg p-4 shadow-xl max-w-sm">
            <p className="text-sm text-foreground mb-4">
              Delete &quot;{deleteConfirm.name}&quot;? This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-3 py-1.5 text-sm rounded bg-secondary text-foreground hover:bg-secondary/80"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteConfirm}
                className="px-3 py-1.5 text-sm rounded bg-red-600 text-white hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
