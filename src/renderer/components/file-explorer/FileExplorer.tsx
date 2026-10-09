import type { DirectoryEntry } from '@shared/types/filesystem.types'
import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { clipboardApi, openerApi } from '@/lib/api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { cn } from '@/lib/utils'
import { useCanvasStore } from '@/stores/canvas-store'
import { useConnectionStatusStore } from '@/stores/connection-status-store'
import { useEditorStore } from '@/stores/editor-store'
import {
  useFileExplorer,
  useFileExplorerActions,
  useFileExplorerStore
} from '@/stores/file-explorer-store'
import { useProjectStore } from '@/stores/project-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import {
  ExplorerGitDecorationsProvider,
  useExplorerGitDecorations
} from './explorer-git-decorations'
import { ExplorerHeader } from './explorer-header'
import {
  DetachedInlineInputRow,
  ExplorerInlineInputProvider,
  InlineCreateRow
} from './explorer-inline-input'
import { ExplorerSearchField, ExplorerSearchResults } from './explorer-search'
import { ExplorerError, ExplorerLoading, ExplorerNoProject } from './explorer-states'
import { FileTreeContextMenuContent } from './FileTreeContextMenu'
import { FileTreeNodeWrapper } from './FileTreeNode'
import { useExplorerEntryFlows } from './use-explorer-entry-flows'
import { useExplorerKeyboard } from './use-explorer-keyboard'
import { EXPLORER_MAX_WIDTH, EXPLORER_MIN_WIDTH, useExplorerResize } from './use-explorer-resize'
import { useExplorerSearch } from './use-explorer-search'

interface FileExplorerProps {
  side?: 'left' | 'right'
}

/**
 * Pure gate for the `.op` open branch (OpenPencil canvas mode): desktop-width
 * viewports open the document as the canvas; the phone-width shell falls
 * through to the existing text-editor flow (canvas is gated off there — the
 * facade would answer UNSUPPORTED_SURFACE anyway).
 */
export function shouldOpenAsCanvas(path: string, isMobileWebShell: boolean): boolean {
  return !isMobileWebShell && path.toLowerCase().endsWith('.op')
}

function copyPath(path: string): void {
  void clipboardApi.writeText(path)
}

function openInTerminal(dirPath: string): void {
  const activeProjectId = useProjectStore.getState().activeProjectId
  if (!activeProjectId) {
    toast.error('No active project')
    return
  }

  try {
    useTerminalStore.getState().addTerminal('Terminal', activeProjectId, 'powershell', dirPath)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to open terminal'
    toast.error(message)
  }
}

async function openWithExternal(filePath: string): Promise<void> {
  const result = await openerApi.openWithExternalApp(filePath)
  if (!result.success) {
    toast.error(`Failed to open file: ${result.error}`)
  }
}

async function showInFileManager(path: string): Promise<void> {
  const result = await openerApi.revealInFileManager(path)
  if (!result.success) {
    toast.error(`Failed to reveal in file manager: ${result.error}`)
  }
}

export function FileExplorer({ side = 'right' }: FileExplorerProps): React.JSX.Element {
  const {
    rootPath,
    directoryContents,
    // (isVisible intentionally not subscribed — WorkspaceLayout owns the
    // mount gate via its AnimatePresence wrap, so a self-gate here would
    // blank the panel mid exit-animation.)
    rootLoadError,
    // (loadingDirs intentionally not subscribed — the recovery effect reads
    // it imperatively via getState() to dodge the auto-expand race.)
    selectedPaths,
    clipboard
  } = useFileExplorer()
  const {
    toggleDirectory,
    selectPath,
    togglePathSelection,
    selectPathRange,
    copySelected,
    cutSelected,
    paste,
    duplicateSelected,
    collapseAll,
    refreshTree,
    retryRootLoad
  } = useFileExplorerActions()

  const { width: explorerWidth, onResizeMouseDown, onResizeKeyDown } = useExplorerResize(side)
  const containerRef = useRef<HTMLDivElement>(null)

  const rootEntries = rootPath ? directoryContents.get(rootPath) : undefined
  const isMobileWebShell = useMobileWebShell()
  const gitDecorations = useExplorerGitDecorations(rootPath)

  // Auto-expand root directory on mount
  useEffect(() => {
    if (rootPath && !directoryContents.has(rootPath) && !rootLoadError) {
      toggleDirectory(rootPath)
    }
  }, [rootPath, directoryContents, rootLoadError, toggleDirectory])
  // Story 10 (F11): when the control channel recovers (reconnect →
  // connected), retry a root that never loaded or errored so the Explorer
  // unsticks without a manual Refresh. The prev-ref starts at null so a
  // MOUNT into an already-connected channel with a stale root error also
  // retries (the auto-expand effect above deliberately skips errored roots).
  // Once connected, later rootLoadError changes do NOT retrigger (a
  // persistently failing root would otherwise retry-loop). Web-only, enforced
  // by an explicit isTauriContext() early-return below.
  const controlChannel = useConnectionStatusStore((state) => state.controlChannel)
  const prevControlChannelRef = useRef<typeof controlChannel | null>(null)
  useEffect(() => {
    // Web-only: on Tauri the terminal/filesystem paths are direct IPC and
    // the channel store never leaves 'connecting' — return BEFORE any retry
    // logic so a mocked/forced 'connected' state can never fire a web
    // recovery on desktop.
    if (isTauriContext()) return
    const prev = prevControlChannelRef.current
    prevControlChannelRef.current = controlChannel
    if (controlChannel !== 'connected' || prev === 'connected') return
    if (!rootPath) return
    // Read imperatively: the auto-expand effect runs just before this one in
    // the same commit and synchronously marks the root as loading — a
    // reactive `loadingDirs` closure would be stale and double-fire a retry.
    const explorerState = useFileExplorerStore.getState()
    const rootMissing =
      !explorerState.directoryContents.has(rootPath) && !explorerState.loadingDirs.has(rootPath)
    if (rootLoadError || rootMissing) void retryRootLoad()
  }, [controlChannel, rootPath, rootLoadError, retryRootLoad])

  const search = useExplorerSearch(rootPath)
  const flows = useExplorerEntryFlows({ rootPath, selectedPaths, directoryContents, containerRef })
  useExplorerKeyboard({
    containerRef,
    rootPath,
    selectedPaths,
    directoryContents,
    onRename: flows.startRename,
    onDelete: flows.requestDelete
  })

  const openFileEntry = useCallback(
    async (path: string) => {
      selectPath(path)
      // OpenPencil canvas mode (CAP-1): a `.op` document opens as the
      // project's singleton canvas tab on desktop-width viewports. On the
      // phone-width shell the canvas is gated off — fall through to the
      // existing text-editor flow. A typed canvas failure (BINARY_NOT_FOUND,
      // HANDSHAKE_TIMEOUT, …) also falls through — the failure itself is
      // logged by canvas-store.openCanvas, and the file still opens in the
      // text editor instead of leaving it selected but unopened.
      if (shouldOpenAsCanvas(path, isMobileWebShell)) {
        const projectId = useProjectStore.getState().activeProjectId
        if (projectId) {
          const opened = await useCanvasStore.getState().openCanvas(projectId, path)
          // 'superseded' means a newer open/close now owns the canvas — NOT
          // a failure, so the text-editor fallback must not run.
          if (opened === 'superseded') return
          if (opened) return
        }
      }
      try {
        await useEditorStore.getState().openFile(path)
        useWorkspaceStore.getState().addEditorTab(path)
      } catch {
        // File couldn't be opened (binary, too large, etc.)
      }
    },
    [selectPath, isMobileWebShell]
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, entry: DirectoryEntry) => {
      // F1: no preventDefault() — Radix's `<ContextMenuTrigger asChild>` composes
      // this handler ahead of its own handleOpen (checkForDefaultPrevented: true);
      // a preventDefault here would make Radix skip opening the menu. Radix's
      // own handleContextMenu already suppresses the native menu.
      e.stopPropagation()
      // If right-clicking on an unselected item, select only that item
      // If right-clicking on a selected item, keep the current selection.
      // Stopping propagation also keeps the global `GlobalContextMenu` trigger
      // from firing over the file tree.
      if (!selectedPaths.has(entry.path)) {
        selectPath(entry.path)
      }
    },
    [selectPath, selectedPaths]
  )

  // Ctrl/Cmd+Click toggles, Shift+Click selects a range, a plain click
  // toggles a folder or opens a file.
  const handleNodeClick = useCallback(
    (e: React.MouseEvent, entry: DirectoryEntry) => {
      const lastClickedPath = useFileExplorerStore.getState().lastClickedPath

      if (e.ctrlKey || e.metaKey) {
        togglePathSelection(entry.path)
      } else if (e.shiftKey && lastClickedPath) {
        selectPathRange(lastClickedPath, entry.path)
      } else if (entry.type === 'directory') {
        toggleDirectory(entry.path)
      } else {
        void openFileEntry(entry.path)
      }
    },
    [togglePathSelection, selectPathRange, toggleDirectory, openFileEntry]
  )

  const { startCreateIn, startRename, requestDelete } = flows
  const handleNewFile = useCallback(
    (dirPath: string) => void startCreateIn(dirPath, 'file'),
    [startCreateIn]
  )
  const handleNewFolder = useCallback(
    (dirPath: string) => void startCreateIn(dirPath, 'folder'),
    [startCreateIn]
  )

  // Per-node Radix context-menu content. `FileTreeNode` wraps each node row in
  // `<ContextMenu><ContextMenuTrigger asChild>{row}</ContextMenuTrigger>{...}</ContextMenu>`;
  // this callback supplies the declarative `<ContextMenuContent>` for a given
  // entry (icons on every item, desktop-only reveal/external-open gated by
  // `isTauriContext()`). The selection count + clipboard presence are captured
  // fresh on every render so the menu reflects the current multi-select state.
  const renderFileTreeContextMenu = useCallback(
    (entry: DirectoryEntry) => (
      <FileTreeContextMenuContent
        entry={entry}
        onNewFile={handleNewFile}
        onNewFolder={handleNewFolder}
        onRename={startRename}
        onDelete={requestDelete}
        onCopyPath={copyPath}
        onCopy={copySelected}
        onCut={cutSelected}
        onPaste={paste}
        onDuplicate={duplicateSelected}
        onOpenInTerminal={openInTerminal}
        onOpenWithExternal={openWithExternal}
        onShowInFileManager={showInFileManager}
        selectedCount={selectedPaths.size}
        hasClipboardContent={clipboard !== null}
      />
    ),
    [
      handleNewFile,
      handleNewFolder,
      startRename,
      requestDelete,
      copySelected,
      cutSelected,
      paste,
      duplicateSelected,
      selectedPaths,
      clipboard
    ]
  )

  const actionsDisabled = !rootPath || !!rootLoadError
  const showTree = !!rootPath && !!rootEntries && !rootLoadError && search.showsTree
  const { deleteTarget } = flows

  return (
    <div
      id="file-explorer-panel"
      ref={containerRef}
      className="relative flex h-full min-w-0 flex-shrink-0 flex-col overflow-hidden rounded-xl bg-background text-foreground"
      style={{ width: explorerWidth }}
    >
      <ExplorerHeader
        actionsDisabled={actionsDisabled}
        onNewFile={() => void flows.startHeaderCreate('file')}
        onNewFolder={() => void flows.startHeaderCreate('folder')}
        onCollapseAll={collapseAll}
        onRefresh={() => void refreshTree()}
      />

      <ExplorerSearchField value={search.query} onChange={search.setQuery} onClear={search.clear} />

      {/* Tree / Search Results */}
      <ExplorerInlineInputProvider value={flows.inlineInputContext}>
        <div className="flex-1 overflow-y-auto overflow-x-hidden pb-2">
          {!rootPath && <ExplorerNoProject />}

          {rootPath && rootLoadError && (
            // Story 10: the guard-bypassing force reload (a hung fetch leaves
            // a stale loadingDirs entry that would make toggleDirectory a no-op).
            <ExplorerError message={rootLoadError.message} onRetry={() => void retryRootLoad()} />
          )}

          {rootPath && !rootEntries && !rootLoadError && <ExplorerLoading />}

          {showTree && rootPath && (
            <ExplorerGitDecorationsProvider value={gitDecorations}>
              <div className="px-2">
                <InlineCreateRow parentPath={rootPath} depth={0} />
                {rootEntries?.map((entry) => (
                  <FileTreeNodeWrapper
                    key={entry.path}
                    entry={entry}
                    depth={0}
                    onContextMenu={handleContextMenu}
                    onClick={handleNodeClick}
                    renderContextMenu={renderFileTreeContextMenu}
                  />
                ))}
              </div>
            </ExplorerGitDecorationsProvider>
          )}

          {!showTree && <DetachedInlineInputRow />}

          {rootPath && !rootLoadError && search.isActive && (
            <ExplorerSearchResults rootPath={rootPath} {...search.results} />
          )}
        </div>
      </ExplorerInlineInputProvider>

      <button
        type="button"
        onMouseDown={onResizeMouseDown}
        onKeyDown={onResizeKeyDown}
        className={cn(
          'absolute top-0 h-full w-1 cursor-col-resize bg-transparent transition-colors duration-150 ease-out hover:bg-border focus-visible:bg-muted-foreground/40 focus-visible:outline-none active:bg-muted-foreground/40',
          side === 'right' ? 'left-0' : 'right-0'
        )}
        title="Drag to resize explorer"
        aria-label="Resize file explorer"
        role="separator"
        aria-controls="file-explorer-panel"
        aria-valuenow={explorerWidth}
        aria-valuemin={EXPLORER_MIN_WIDTH}
        aria-valuemax={EXPLORER_MAX_WIDTH}
      />

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title={deleteTarget?.type === 'directory' ? 'Delete folder' : 'Delete file'}
        message={deleteTarget ? `Delete "${deleteTarget.name}"? This cannot be undone.` : ''}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => void flows.confirmDelete()}
        onCancel={flows.cancelDelete}
      />
    </div>
  )
}
