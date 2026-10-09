import { ConfirmDialog } from '@/components/ConfirmDialog'
import { BranchSwitchDialog, CreateBranchDialog } from '@/components/git/BranchSection'
import { AmendCommitDialog } from '@/components/git/CommitComposer'
import { StashDialog } from '@/components/git/StashSection'
import type { useGitActions } from '@/components/git/use-git-actions'

/**
 * Dialogs owned by the Git panel. Rendered at the panel root so they stay
 * mounted across the mobile file-list/diff-view swap.
 */
export function GitPanelDialogs({ actions }: { actions: ReturnType<typeof useGitActions> }) {
  const {
    isMutating,
    isGenerating,
    isCommitting,
    confirmDiscardOpen,
    setConfirmDiscardOpen,
    discardTargets,
    setDiscardTargets,
    confirmDiscard,
    confirmAmendOpen,
    setConfirmAmendOpen,
    runCommit,
    isCreateBranchOpen,
    setIsCreateBranchOpen,
    branchNameInput,
    setBranchNameInput,
    handleCreateBranch,
    isStashOpen,
    setIsStashOpen,
    stashMessage,
    setStashMessage,
    stashIncludeUntracked,
    setStashIncludeUntracked,
    handleStashSave,
    confirmBranchSwitchOpen,
    setConfirmBranchSwitchOpen,
    pendingBranchName,
    handleExecuteSwitchBranch
  } = actions

  return (
    <>
      <ConfirmDialog
        isOpen={confirmDiscardOpen}
        variant="danger"
        title="Discard changes"
        message={
          discardTargets.length > 1
            ? `Discard changes to ${discardTargets.length} files? This cannot be undone.`
            : discardTargets[0]
              ? `Discard changes to "${discardTargets[0]}"? This cannot be undone.`
              : ''
        }
        confirmLabel="Discard"
        isLoading={isMutating}
        onConfirm={confirmDiscard}
        onCancel={() => {
          setConfirmDiscardOpen(false)
          setDiscardTargets([])
        }}
      />

      <AmendCommitDialog
        isOpen={confirmAmendOpen}
        isLoading={isCommitting}
        onConfirm={runCommit}
        onCancel={() => setConfirmAmendOpen(false)}
      />

      <CreateBranchDialog
        open={isCreateBranchOpen}
        onOpenChange={setIsCreateBranchOpen}
        branchName={branchNameInput}
        onBranchNameChange={setBranchNameInput}
        isMutating={isMutating}
        isGenerating={isGenerating}
        onCreate={handleCreateBranch}
      />

      <StashDialog
        open={isStashOpen}
        onOpenChange={setIsStashOpen}
        message={stashMessage}
        onMessageChange={setStashMessage}
        includeUntracked={stashIncludeUntracked}
        onIncludeUntrackedChange={setStashIncludeUntracked}
        isMutating={isMutating}
        isGenerating={isGenerating}
        onSave={handleStashSave}
      />

      <BranchSwitchDialog
        open={confirmBranchSwitchOpen}
        onOpenChange={setConfirmBranchSwitchOpen}
        pendingBranchName={pendingBranchName}
        isMutating={isMutating}
        isGenerating={isGenerating}
        onExecute={handleExecuteSwitchBranch}
      />
    </>
  )
}
