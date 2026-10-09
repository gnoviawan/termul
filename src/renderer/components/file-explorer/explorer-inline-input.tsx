import type { DirectoryEntry } from '@shared/types/filesystem.types'
import { createContext, useContext, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { MaterialFileIcon } from './MaterialFileIcon'
import { normalizeTreePath } from './tree-paths'

/**
 * Inline create / rename input for the file tree.
 *
 * The input shows IN PLACE: a rename replaces the name inside the row being
 * renamed, and a create shows as a new row at the top of the target folder's
 * children. FileExplorer owns the state and the submit / cancel logic; the
 * tree rows read it through this context.
 */

export interface InlineInputState {
  parentPath: string
  type: 'file' | 'folder'
  mode: 'create' | 'rename'
  existingEntry?: DirectoryEntry
}

export interface ExplorerInlineInputContextValue {
  inlineInput: InlineInputState | null
  value: string
  setValue: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
}

const ExplorerInlineInputContext = createContext<ExplorerInlineInputContextValue>({
  inlineInput: null,
  value: '',
  setValue: () => {},
  onSubmit: () => {},
  onCancel: () => {}
})

export const ExplorerInlineInputProvider = ExplorerInlineInputContext.Provider

export function useExplorerInlineInput(): ExplorerInlineInputContextValue {
  return useContext(ExplorerInlineInputContext)
}

/** Tree row indent: 4px inset + 14px per level (matches the chevron slot). */
export function treeRowPaddingLeft(depth: number): number {
  return 4 + depth * 14
}

/** True when `entry` is the row being renamed. */
export function isRenameTarget(inlineInput: InlineInputState | null, entryPath: string): boolean {
  return (
    inlineInput?.mode === 'rename' &&
    inlineInput.existingEntry !== undefined &&
    normalizeTreePath(inlineInput.existingEntry.path) === normalizeTreePath(entryPath)
  )
}

/** True when a create input belongs at the top of `dirPath`'s children. */
export function isCreateTarget(inlineInput: InlineInputState | null, dirPath: string): boolean {
  return (
    inlineInput?.mode === 'create' &&
    normalizeTreePath(inlineInput.parentPath) === normalizeTreePath(dirPath)
  )
}

/**
 * The text field. It takes focus when it appears; on rename it selects the
 * name without the extension (files) or the full name (folders).
 */
export function InlineNameInput({ className }: { className?: string }): React.JSX.Element | null {
  const { inlineInput, value, setValue, onSubmit, onCancel } = useExplorerInlineInput()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const input = inputRef.current
    if (!inlineInput || !input) return
    input.focus()
    if (inlineInput.mode === 'rename' && inlineInput.existingEntry) {
      const name = inlineInput.existingEntry.name
      const dotIndex = inlineInput.existingEntry.type === 'file' ? name.lastIndexOf('.') : -1
      if (dotIndex > 0) {
        input.setSelectionRange(0, dotIndex)
      } else {
        input.select()
      }
    }
  }, [inlineInput])

  if (!inlineInput) return null

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          onSubmit()
        } else if (event.key === 'Escape') {
          onCancel()
        }
      }}
      onBlur={onCancel}
      // The input sits inside a clickable, draggable tree row. Keep clicks
      // and drags in the field.
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onDragStart={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      className={cn(
        'h-6 min-w-0 flex-1 rounded border border-ring bg-card px-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/70',
        className
      )}
      aria-label={
        inlineInput.mode === 'rename'
          ? 'New name'
          : inlineInput.type === 'file'
            ? 'New file name'
            : 'New folder name'
      }
      placeholder={
        inlineInput.mode === 'create'
          ? inlineInput.type === 'file'
            ? 'File name...'
            : 'Folder name...'
          : 'New name...'
      }
    />
  )
}

/**
 * A new-entry row at `depth`. Renders only when a create targets `parentPath`.
 */
export function InlineCreateRow({
  parentPath,
  depth
}: {
  parentPath: string
  depth: number
}): React.JSX.Element | null {
  const { inlineInput } = useExplorerInlineInput()
  if (!inlineInput || !isCreateTarget(inlineInput, parentPath)) return null

  return (
    <div
      className="relative flex h-7 min-w-0 items-center rounded-md pr-1 text-xs"
      style={{ paddingLeft: treeRowPaddingLeft(depth) }}
    >
      <span className="mr-0.5 size-3.5 shrink-0" />
      <MaterialFileIcon
        name={inlineInput.type === 'folder' ? 'folder' : 'file'}
        extension={null}
        isDirectory={inlineInput.type === 'folder'}
        isExpanded={false}
        depth={depth}
        size={14}
        className="mr-1"
      />
      <InlineNameInput />
    </div>
  )
}

/**
 * The input at the top of the list while the tree is hidden (search results,
 * loading), so an open create / rename stays reachable.
 */
export function DetachedInlineInputRow(): React.JSX.Element | null {
  const { inlineInput } = useExplorerInlineInput()
  if (!inlineInput) return null

  return (
    <div className="flex h-7 items-center px-3">
      <InlineNameInput />
    </div>
  )
}
