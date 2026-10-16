import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  type BulkCloseRequest,
  isEditorTabBusy,
  NO_APPROVED_DIRTY
} from '@/layouts/workspace-layout/bulk-close'
import { blockSaveOnDraftConflict } from '@/layouts/workspace-layout/draft-conflict-save-guard'
import { fileNeedsAttention } from '@/lib/editor-file-attention'
import { logFrontendError } from '@/lib/log-api'
import { closeWorkspaceTab } from '@/lib/workspace-tab-close'
import { useConfirmTerminalClose } from '@/stores/app-settings-store'
import { useEditorStore } from '@/stores/editor-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { editorTabId, useWorkspaceStore, type WorkspaceTab } from '@/stores/workspace-store'

function closeBulkEditorTab(filePath: string, approvedDirty: ReadonlySet<string>): void {
  const fileState = useEditorStore.getState().openFiles.get(filePath)
  if (!fileState) {
    useWorkspaceStore.getState().removeTab(editorTabId(filePath))
    return
  }
  if (fileNeedsAttention(fileState) && !approvedDirty.has(filePath)) {
    void logFrontendError({
      level: 'warn',
      source: 'WorkspaceLayout.bulkClose',
      message: `bulk close: skipped ${filePath} — file became dirty after confirmation`
    })
    return
  }
  if (useEditorStore.getState().closeFileIfIdle(filePath)) {
    useWorkspaceStore.getState().removeTab(editorTabId(filePath))
    return
  }
  void logFrontendError({
    level: 'warn',
    source: 'WorkspaceLayout.bulkClose',
    message: `bulk close: editor tab ${editorTabId(filePath)} did not close`
  })
}

interface UseBulkTabCloseOptions {
  activeProjectId: string
  closingTerminalIds: string[]
  closeTerminalTabByTabId: (tabId: string) => Promise<boolean>
}

/** Aggregate "close many tabs" flow: one confirm dialog for the whole target list. */
export function useBulkTabClose({
  activeProjectId,
  closingTerminalIds,
  closeTerminalTabByTabId
}: UseBulkTabCloseOptions) {
  const confirmTerminalClose = useConfirmTerminalClose()
  const [bulkClose, setBulkClose] = useState<BulkCloseRequest | null>(null)
  const [bulkCloseLoading, setBulkCloseLoading] = useState(false)

  // Bulk close dispatch: every tab routes through its normal close primitive
  // minus the per-item dialog (the aggregate dialog replaced it upstream).
  // Per-tab failures surface through the renderer log, not silently.
  // `approvedDirty` is the set of editor paths whose dirty state was covered
  // by the aggregate confirmation (Save & Close / Don't Save) — anything else
  // dirty at execute time is skipped rather than discarded without consent.
  const closeBulkTabNow = useCallback(
    (tab: WorkspaceTab, approvedDirty: ReadonlySet<string>): void => {
      closeWorkspaceTab(
        tab,
        {
          terminal: (terminalTab) => {
            void closeTerminalTabByTabId(terminalTab.id)
              .then((didClose) => {
                if (!didClose) {
                  void logFrontendError({
                    level: 'warn',
                    source: 'WorkspaceLayout.bulkClose',
                    message: `bulk close: terminal tab ${terminalTab.id} did not close`
                  })
                }
              })
              .catch((error) => {
                void logFrontendError({
                  level: 'warn',
                  source: 'WorkspaceLayout.bulkClose',
                  message: `bulk close: terminal tab ${terminalTab.id} close threw: ${error instanceof Error ? error.message : String(error)}`
                })
              })
            return false
          },
          editor: (editorTab) => {
            closeBulkEditorTab(editorTab.filePath, approvedDirty)
            return false
          }
        },
        'WorkspaceLayout.bulkClose'
      )
    },
    [closeTerminalTabByTabId]
  )

  // One throwing close primitive must not skip the remaining targets.
  const closeBulkTabSafely = useCallback(
    (tab: WorkspaceTab, approvedDirty: ReadonlySet<string>): void => {
      try {
        closeBulkTabNow(tab, approvedDirty)
      } catch (error) {
        void logFrontendError({
          level: 'warn',
          source: 'WorkspaceLayout.bulkClose',
          message: `bulk close: tab ${tab.id} close threw: ${error instanceof Error ? error.message : String(error)}`
        })
      }
    },
    [closeBulkTabNow]
  )

  // Currently-dirty targeted editor paths, recomputed at execute time: a
  // path that left openFiles while the dialog was open is skipped instead of
  // spuriously aborting on saveFile(false), and a file dirtied while the
  // dialog was open is folded into the consented set.
  const bulkApprovedDirtyPaths = useCallback((tabs: WorkspaceTab[]): Set<string> => {
    return new Set(
      tabs
        .filter((tab): tab is WorkspaceTab & { type: 'editor' } => tab.type === 'editor')
        .map((tab) => tab.filePath)
        .filter((filePath) => fileNeedsAttention(useEditorStore.getState().openFiles.get(filePath)))
    )
  }, [])

  // `onCloseTabs` from WorkspaceTabBar: compute the confirm-required subset
  // once, then either close everything directly or open ONE aggregate dialog.
  const handleCloseTabs = useCallback(
    (targetTabs: WorkspaceTab[]): void => {
      // The aggregate request is single-slot — never overwrite a pending one.
      if (bulkClose) {
        void logFrontendError({
          level: 'warn',
          source: 'WorkspaceLayout.bulkClose',
          message: 'bulk close requested while an aggregate close dialog is already open'
        })
        return
      }
      // Skip tabs the single-close guards would refuse anyway: terminals with
      // a close already in flight (or no store record) and editors mid-save.
      const actionable = targetTabs.filter((tab) => {
        if (tab.type === 'terminal') {
          return (
            !closingTerminalIds.includes(tab.terminalId) &&
            useTerminalStore.getState().terminals.some((t) => t.id === tab.terminalId)
          )
        }
        if (tab.type === 'editor') {
          return !isEditorTabBusy(tab.filePath)
        }
        return true
      })
      if (actionable.length === 0) {
        void logFrontendError({
          level: 'info',
          source: 'WorkspaceLayout.bulkClose',
          message: `bulk close no-op: all ${targetTabs.length} target(s) filtered out by close guards`
        })
        return
      }

      const terminalTabs = actionable.filter((tab) => tab.type === 'terminal')
      const dirtyFilePaths = actionable
        .filter((tab): tab is WorkspaceTab & { type: 'editor' } => tab.type === 'editor')
        .map((tab) => tab.filePath)
        .filter((filePath) => fileNeedsAttention(useEditorStore.getState().openFiles.get(filePath)))
      const confirmRequired =
        (confirmTerminalClose && terminalTabs.length > 0) || dirtyFilePaths.length > 0

      void logFrontendError({
        level: 'info',
        source: 'WorkspaceLayout.bulkClose',
        message: `bulk close requested: ${actionable.length} tab(s), ${terminalTabs.length} terminal(s), ${dirtyFilePaths.length} dirty file(s), confirmRequired=${confirmRequired}`
      })

      if (!confirmRequired) {
        for (const tab of actionable) {
          closeBulkTabSafely(tab, NO_APPROVED_DIRTY)
        }
        return
      }

      setBulkClose({
        tabs: actionable,
        terminalCount: terminalTabs.length,
        dirtyFilePaths
      })
    },
    [bulkClose, closeBulkTabSafely, closingTerminalIds, confirmTerminalClose]
  )

  const handleBulkCloseConfirm = useCallback(async () => {
    if (!bulkClose || bulkCloseLoading) return

    setBulkCloseLoading(true)
    try {
      // Save & Close: every currently-dirty targeted file must save before
      // ANY tab closes; a single failure aborts the whole bulk action. When
      // the dialog was raised for terminals only (plain "Close"), the
      // approved set stays empty so a file dirtied meanwhile is skipped and
      // warned in closeBulkTabNow instead of being discarded.
      const approvedDirty =
        bulkClose.dirtyFilePaths.length > 0
          ? bulkApprovedDirtyPaths(bulkClose.tabs)
          : NO_APPROVED_DIRTY
      // A draft-conflicted file cannot be saved here: reveal it, close nothing.
      if (blockSaveOnDraftConflict(approvedDirty)) {
        setBulkClose(null)
        return
      }
      for (const filePath of approvedDirty) {
        const saved = await useEditorStore.getState().saveFile(filePath)
        if (!saved) {
          toast.error('Failed to save file. No tabs were closed.')
          void logFrontendError({
            level: 'warn',
            source: 'WorkspaceLayout.bulkClose',
            message: `bulk close aborted: saveFile failed for ${filePath}`
          })
          setBulkClose(null)
          return
        }
      }
      for (const tab of bulkClose.tabs) {
        closeBulkTabSafely(tab, approvedDirty)
      }
      setBulkClose(null)
    } catch (error) {
      // The failure may have come from the close phase after some tabs
      // already closed, so don't claim "no tabs were closed" here.
      toast.error('Bulk close aborted')
      void logFrontendError({
        source: 'WorkspaceLayout.bulkClose',
        message: `bulk close aborted: ${error instanceof Error ? error.message : String(error)}`
      })
      setBulkClose(null)
    } finally {
      setBulkCloseLoading(false)
    }
  }, [bulkClose, bulkCloseLoading, bulkApprovedDirtyPaths, closeBulkTabSafely])

  // Don't Save / Discard & Close: dirty editor contents are dropped by
  // closeFileIfIdle; every other target closes through its normal path.
  const handleBulkCloseDiscard = useCallback(() => {
    if (!bulkClose) return
    const approvedDirty =
      bulkClose.dirtyFilePaths.length > 0
        ? bulkApprovedDirtyPaths(bulkClose.tabs)
        : NO_APPROVED_DIRTY
    for (const tab of bulkClose.tabs) {
      closeBulkTabSafely(tab, approvedDirty)
    }
    setBulkClose(null)
  }, [bulkClose, bulkApprovedDirtyPaths, closeBulkTabSafely])

  const handleBulkCloseCancel = useCallback(() => {
    if (bulkCloseLoading) return
    setBulkClose(null)
  }, [bulkCloseLoading])

  // A project switch swaps every store the pending request references — a
  // stale aggregate dialog must never act on the new project's tabs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on activeProjectId intentionally — the reset runs on switch, not on reads
  useEffect(() => {
    setBulkClose(null)
    setBulkCloseLoading(false)
  }, [activeProjectId])

  return {
    bulkClose,
    bulkCloseLoading,
    handleCloseTabs,
    handleBulkCloseConfirm,
    handleBulkCloseDiscard,
    handleBulkCloseCancel
  }
}
