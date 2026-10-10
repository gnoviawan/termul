import { ConfirmDialog } from '@/components/ConfirmDialog'
import { pluralizeCount } from '@/layouts/workspace-layout/bulk-close'
import type { useAppClose } from '@/layouts/workspace-layout/use-app-close'
import type { useBulkTabClose } from '@/layouts/workspace-layout/use-bulk-tab-close'
import type { useEditorTabClose } from '@/layouts/workspace-layout/use-editor-tab-close'
import type { useTerminalClose } from '@/layouts/workspace-layout/use-terminal-close'
import type { Terminal } from '@/types/project'

export interface WorkspaceCloseDialogsProps {
  terminals: Terminal[]
  terminalClose: ReturnType<typeof useTerminalClose>
  editorTabClose: ReturnType<typeof useEditorTabClose>
  appClose: ReturnType<typeof useAppClose>
  bulkTabClose: ReturnType<typeof useBulkTabClose>
}

/** The four close confirmations: terminal, dirty file, app close and bulk tab close. */
export function WorkspaceCloseDialogs({
  terminals,
  terminalClose,
  editorTabClose,
  appClose,
  bulkTabClose
}: WorkspaceCloseDialogsProps): React.JSX.Element {
  const {
    closeConfirmTerminal,
    closeConfirmLoading,
    closeConfirmRememberChoice,
    setCloseConfirmRememberChoice,
    handleConfirmCloseTerminal,
    handleCancelCloseTerminal
  } = terminalClose
  const { dirtyCloseFilePath, handleDiscardAndClose, handleSaveThenClose, handleCancelDirtyClose } =
    editorTabClose
  const {
    isAppCloseDialogOpen,
    appCloseDirtyCount,
    handleDiscardAllAndClose,
    handleSaveAllAndClose,
    handleCancelAppClose
  } = appClose
  const {
    bulkClose,
    bulkCloseLoading,
    handleBulkCloseDiscard,
    handleBulkCloseConfirm,
    handleBulkCloseCancel
  } = bulkTabClose

  const terminalToClose = terminals.find((t) => t.id === closeConfirmTerminal?.terminalId)

  return (
    <>
      {/* Close Terminal Confirmation */}
      <ConfirmDialog
        isOpen={closeConfirmTerminal !== null}
        title="Close Terminal"
        message={`Are you sure you want to close "${
          terminalToClose?.name || 'this terminal'
        }"? Any running processes will be terminated.`}
        confirmLabel="Close"
        cancelLabel="Cancel"
        variant="danger"
        isLoading={closeConfirmLoading}
        onConfirm={handleConfirmCloseTerminal}
        onCancel={handleCancelCloseTerminal}
      >
        <label className="flex items-center gap-2 text-xs text-muted-foreground select-none">
          <input
            type="checkbox"
            checked={closeConfirmRememberChoice}
            onChange={(e) => setCloseConfirmRememberChoice(e.target.checked)}
            disabled={closeConfirmLoading}
            className="rounded border-border bg-background"
          />
          Don't ask again when closing terminals
        </label>
      </ConfirmDialog>

      {/* Dirty File Close Confirmation */}
      <ConfirmDialog
        isOpen={dirtyCloseFilePath !== null}
        title="Unsaved Changes"
        message={`Save changes to "${dirtyCloseFilePath?.split(/[\\/]/).pop() ?? ''}" before closing?`}
        confirmLabel="Save"
        cancelLabel="Cancel"
        secondaryAction={{ label: 'Discard', onClick: handleDiscardAndClose }}
        onConfirm={handleSaveThenClose}
        onCancel={handleCancelDirtyClose}
      />

      {/* App Close Unsaved Files Confirmation */}
      <ConfirmDialog
        isOpen={isAppCloseDialogOpen}
        title="Unsaved Changes"
        message={`You have ${appCloseDirtyCount} unsaved file${appCloseDirtyCount !== 1 ? 's' : ''}. Save changes before closing?`}
        confirmLabel="Save All"
        cancelLabel="Cancel"
        secondaryAction={{
          label: "Don't Save",
          onClick: handleDiscardAllAndClose
        }}
        onConfirm={handleSaveAllAndClose}
        onCancel={handleCancelAppClose}
      />

      {/* Bulk tab close — ONE aggregate dialog for the whole target list.
          Dirty editors add the save/discard split from the app-close pattern;
          terminals already closing or editors mid-save were filtered out in
          handleCloseTabs before this state was set. */}
      <ConfirmDialog
        isOpen={bulkClose !== null}
        title="Close Tabs"
        message={(() => {
          if (!bulkClose) return ''
          const parts: string[] = []
          if (bulkClose.terminalCount > 0) {
            parts.push(
              `${pluralizeCount(bulkClose.terminalCount, 'terminal has', 'terminals have')} running processes`
            )
          }
          if (bulkClose.dirtyFilePaths.length > 0) {
            parts.push(
              `${pluralizeCount(bulkClose.dirtyFilePaths.length, 'file has', 'files have')} unsaved changes`
            )
          }
          return `Close ${pluralizeCount(bulkClose.tabs.length, 'tab', 'tabs')}? ${parts.join('; ')}.`
        })()}
        confirmLabel={bulkClose && bulkClose.dirtyFilePaths.length > 0 ? 'Save & Close' : 'Close'}
        cancelLabel="Cancel"
        variant="danger"
        isLoading={bulkCloseLoading}
        secondaryAction={
          bulkClose && bulkClose.dirtyFilePaths.length > 0
            ? { label: "Don't Save", onClick: handleBulkCloseDiscard }
            : undefined
        }
        onConfirm={() => void handleBulkCloseConfirm()}
        onCancel={handleBulkCloseCancel}
      />
    </>
  )
}
