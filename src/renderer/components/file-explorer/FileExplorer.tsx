import { useState, useCallback, useRef, useEffect } from 'react'
import { ChevronsDownUp } from 'lucide-react'
import { FileTreeNodeWrapper } from './FileTreeNode'
import { FileTreeContextMenu } from './FileTreeContextMenu'
import {
  useFileExplorer,
  useFileExplorerActions,
  useFileExplorerStore
} from '@/stores/file-explorer-store'
import { useEditorStore } from '@/stores/editor-store'
import { useWorkspaceStore, editorTabId } from '@/stores/workspace-store'
import type { DirectoryEntry } from '@shared/types/filesystem.types'
import { toast } from 'sonner'

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

export function FileExplorer(): React.JSX.Element {
  const { rootPath, directoryContents, isVisible, rootLoadError } = useFileExplorer()
  const {
    toggleDirectory,
    selectPath,
    collapseAll,
    refreshDirectory,
    setRootLoadError
  } = useFileExplorerActions()

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [inlineInput, setInlineInput] = useState<InlineInputState | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState<DirectoryEntry | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const rootEntries = rootPath ? directoryContents.get(rootPath) : undefined

  // Auto-expand root directory on mount
  useEffect(() => {
    if (rootPath && !directoryContents.has(rootPath) && !rootLoadError) {
      toggleDirectory(rootPath)
    }
  }, [rootPath, directoryContents, rootLoadError, toggleDirectory])

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
        useWorkspaceStore.getState().setActiveTab(editorTabId(path))
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
      selectPath(entry.path)
      setContextMenu({ x: e.clientX, y: e.clientY, entry })
    },
    [selectPath]
  )

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
    const parentPath = lastSlash > 0 ? normalizedPath.slice(0, lastSlash) : lastSlash === 0 ? '/' : ''
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
    window.api.clipboard.writeText(path)
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
    const fullPath = inlineInput.parentPath + '/' + name

    try {
      if (inlineInput.mode === 'create') {
        if (inlineInput.type === 'file') {
          await window.api.filesystem.createFile(fullPath)
        } else {
          await window.api.filesystem.createDirectory(fullPath)
        }
      } else if (inlineInput.mode === 'rename' && inlineInput.existingEntry) {
        await window.api.filesystem.renameFile(inlineInput.existingEntry.path, fullPath)

        // If the renamed file was open in editor, close old tab
        const editorState = useEditorStore.getState()
        if (editorState.openFiles.has(inlineInput.existingEntry.path)) {
          editorState.closeFile(inlineInput.existingEntry.path)
          useWorkspaceStore.getState().removeTab(
            editorTabId(inlineInput.existingEntry.path)
          )
        }
      }
      await refreshDirectory(inlineInput.parentPath)
      setInlineInput(null)
      setInputValue('')
    } catch {
      submitFailedRef.current = true
    }

    isSubmittingRef.current = false
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

    try {
      await window.api.filesystem.deleteFile(deleteConfirm.path)

      // Close editor tab if file was open
      const editorState = useEditorStore.getState()
      if (editorState.openFiles.has(deleteConfirm.path)) {
        editorState.closeFile(deleteConfirm.path)
        useWorkspaceStore.getState().removeTab(editorTabId(deleteConfirm.path))
      }

      const normalizedDeletePath = deleteConfirm.path.replace(/\\/g, '/')
      const parentPath = normalizedDeletePath.substring(
        0,
        normalizedDeletePath.lastIndexOf('/')
      )
      await refreshDirectory(parentPath)
      setDeleteConfirm(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      toast.error(`Failed to delete ${deleteConfirm.path}: ${message}`)
    }
  }, [deleteConfirm, refreshDirectory])

  const handleRootRetry = useCallback(() => {
    if (!rootPath) return
    setRootLoadError(null)
    void toggleDirectory(rootPath)
  }, [rootPath, setRootLoadError, toggleDirectory])

  if (!isVisible) return <></>

  return (
    <div className="h-full flex flex-col bg-background text-foreground">
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-10 border-b border-border flex-shrink-0">
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

      {/* Tree */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden py-1">
        {!rootPath && (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            No project selected
          </div>
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

        {rootPath && rootEntries && !rootLoadError && (
          <>
            {rootEntries.map((entry) => (
              <FileTreeNodeWrapper
                key={entry.path}
                entry={entry}
                depth={0}
                onToggle={toggleDirectory}
                onSelect={handleSelect}
                onContextMenu={handleContextMenu}
              />
            ))}
          </>
        )}

        {/* Inline input for new file/folder/rename */}
        {inlineInput && (
          <div
            className="flex items-center px-2 py-0.5"
            style={{ paddingLeft: 20 }}
          >
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
