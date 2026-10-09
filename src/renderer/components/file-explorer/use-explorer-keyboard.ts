import type { DirectoryEntry } from '@shared/types/filesystem.types'
import { useEffect } from 'react'
import { useFileExplorerActions } from '@/stores/file-explorer-store'
import { findTreeEntry, parentTreePath } from './tree-paths'

interface ExplorerKeyboardOptions {
  /** The explorer panel: shortcuts apply while focus is in it (or on body). */
  containerRef: React.RefObject<HTMLDivElement | null>
  rootPath: string | null
  selectedPaths: Set<string>
  directoryContents: Map<string, DirectoryEntry[]>
  onRename: (entry: DirectoryEntry) => void
  onDelete: (entry: DirectoryEntry) => void
}

/** Ctrl+V target: the selected folder, else the selected file's folder, else the root. */
function pasteTargetDir(
  rootPath: string | null,
  selectedPaths: Set<string>,
  directoryContents: Map<string, DirectoryEntry[]>
): string | undefined {
  if (selectedPaths.size === 1) {
    const [selectedPath] = selectedPaths
    if (findTreeEntry(directoryContents, selectedPath)?.type === 'directory') return selectedPath
    const parent = parentTreePath(selectedPath)
    if (parent && parent !== '/') return parent
  }
  return rootPath ?? undefined
}

/**
 * Explorer keyboard shortcuts on the document: Ctrl/Cmd+A, C, X, V, F2
 * (rename), Delete and Escape (clear selection).
 */
export function useExplorerKeyboard({
  containerRef,
  rootPath,
  selectedPaths,
  directoryContents,
  onRename,
  onDelete
}: ExplorerKeyboardOptions): void {
  const { selectAll, copySelected, cutSelected, paste, clearSelection } = useFileExplorerActions()

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

      if (e.ctrlKey || e.metaKey) {
        switch (e.key) {
          case 'a':
            e.preventDefault()
            selectAll()
            return
          case 'c':
            e.preventDefault()
            copySelected()
            return
          case 'x':
            e.preventDefault()
            cutSelected()
            return
          case 'v': {
            e.preventDefault()
            const targetPath = pasteTargetDir(rootPath, selectedPaths, directoryContents)
            if (targetPath) void paste(targetPath)
            return
          }
        }
      }

      if (e.key === 'F2' && selectedPaths.size === 1) {
        e.preventDefault()
        const [path] = selectedPaths
        const entry = findTreeEntry(directoryContents, path)
        if (entry) onRename(entry)
        return
      }

      // Delete asks to confirm the first selected entry.
      // TODO: Implement batch delete with multi-select
      if (e.key === 'Delete' && selectedPaths.size > 0) {
        e.preventDefault()
        const [path] = selectedPaths
        const entry = findTreeEntry(directoryContents, path)
        if (entry) onDelete(entry)
        return
      }

      if (e.key === 'Escape') {
        clearSelection()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [
    containerRef,
    selectAll,
    copySelected,
    cutSelected,
    paste,
    selectedPaths,
    directoryContents,
    clearSelection,
    rootPath,
    onRename,
    onDelete
  ])
}
