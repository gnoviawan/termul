import { useEditorStore } from '@/stores/editor-store'
import type { WorkspaceTab } from '@/stores/workspace-store'

/**
 * Shared close guard for editor tabs: `saving`/`reloading` block closing;
 * the transient `saved` flash does not. Used by the single-close path, the
 * bulk-close dispatch, and the aggregate-confirm classification.
 */
export function isEditorTabBusy(filePath: string): boolean {
  const status = useEditorStore.getState().openFiles.get(filePath)?.operationStatus ?? 'idle'
  return status === 'saving' || status === 'reloading'
}

export function pluralizeCount(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`
}

/**
 * Approved-dirty set for the paths where no dirty-editor consent exists:
 * the direct dispatch (nothing needed confirmation) and the terminal-only
 * "Close" dialog. A targeted editor that is dirty at execute time against
 * this set is skipped with a warn log rather than discarded.
 */
export const NO_APPROVED_DIRTY: ReadonlySet<string> = new Set<string>()

/** Aggregate bulk-close confirmation payload (one dialog per bulk action). */
export interface BulkCloseRequest {
  tabs: WorkspaceTab[]
  /** Terminals targeted while `confirmTerminalClose` is on. */
  terminalCount: number
  /** Dirty editors targeted (drive the Save & Close / Don't Save actions). */
  dirtyFilePaths: string[]
}
