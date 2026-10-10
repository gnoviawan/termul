import { ConfirmDialog } from '@/components/ConfirmDialog'
import { BranchSwitchDialog, CreateBranchDialog } from '@/components/git/BranchSection'
import { AmendCommitDialog } from '@/components/git/CommitComposer'
import { StashDialog } from '@/components/git/StashSection'
import type { GitActions } from '@/components/git/use-git-actions'

interface GitPanelDialogsProps {
  actions: GitActions
}

/** The five git dialogs: discard confirm, amend, create branch, stash, branch switch. */
export function GitPanelDialogs({ actions }: GitPanelDialogsProps) {
  const {
    isMutating,
    confirmDiscardOpen,
    setConfirmDiscardOpen,
    discardTargets,
    setDiscardTargets,
    isCreateBranchOpen,
    setIsCreateBranchOpen,
    branchNameInput,
    setBranchNameInput,
    isStashOpen,
    setIsStashOpen,
    stashMessage,
    setStashMessage,
    stashIncludeUntracked,
    setStashIncludeUntracked,
    confirmBranchSwitchOpen,
    setConfirmBranchSwitchOpen,
    pendingBranchName,
    isCommitting,
    isGenerating,
    confirmAmendOpen,
    setConfirmAmendOpen,
    confirmDiscard,
    runCommit,
    handleExecuteSwitchBranch,
    handleCreateBranch,
    handleStashSave
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
