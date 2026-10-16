import type { GitStatusDetail } from '@shared/types/ipc.types'
import type React from 'react'
import { useCallback } from 'react'
import { CommitComposer } from '@/components/git/CommitComposer'
import { GitChangeList } from '@/components/git/GitChangeList'
import { GitPanelDialogs } from '@/components/git/GitPanelDialogs'
import { GitPanelHeader } from '@/components/git/GitPanelHeader'
import { useGitActions } from '@/components/git/use-git-actions'
import { useGitPanelModel } from '@/components/git/use-git-panel-model'
import { useGitSelection } from '@/components/git/use-git-selection'
import { HistoryRow } from '@/components/shell/HistoryRow'
import { useWorkspaceActions } from '@/stores/workspace-store/selectors'

interface ChangesPanelProps {
  /** Working copy the panel shows; the caller resolves it. */
  cwd: string
  isVisible: boolean
}

/**
 * Shell Changes panel (CAP-8): the Git tab's parts in one narrow column with
 * a History row at the bottom. The upper region (branch + Stash, commit box,
 * filter, Change list, Stash list) scrolls on its own above the row, which
 * opens Git History in the main panel. A plain file click opens the Diff tab;
 * the diff itself is not shown here.
 */
export function ChangesPanel({ cwd, isVisible }: ChangesPanelProps): React.JSX.Element {
  const { addDiffTab } = useWorkspaceActions()

  const {
    selectedFile,
    stashes,
    branches,
    searchQuery,
    setSearchQuery,
    stagedFiles,
    unstagedFiles
  } = useGitPanelModel({ cwd, isVisible })

  const {
    selectedStaged,
    setSelectedStaged,
    selectedPaths,
    selectionSection,
    clearSelection,
    handleFileClick,
    targetsFor
  } = useGitSelection()

  const actions = useGitActions({ cwd, setSelectedStaged, clearSelection })
  const {
    isMutating,
    setIsCreateBranchOpen,
    setIsStashOpen,
    summary,
    setSummary,
    description,
    setDescription,
    amend,
    isCommitting,
    isGenerating,
    isPushing,
    hasUncommittedChanges,
    commitContext,
    stagedCount,
    hasUsableAgent,
    canGenerate,
    canCommit,
    runStage,
    runUnstage,
    requestDiscard,
    handleToggleAmend,
    handleGenerateMessage,
    handleCommit,
    handlePush,
    handleSwitchBranch,
    handleApplyStash,
    handlePopStash,
    handleDropStash
  } = actions

  const stagedSelectionCount = selectionSection === 'staged' ? selectedPaths.size : 0
  const unstagedSelectionCount = selectionSection === 'unstaged' ? selectedPaths.size : 0

  // Selection always follows the click; only a plain click also opens the Diff
  // tab (shift / ctrl / meta clicks are selection gestures).
  const onFileClick = useCallback(
    (
      e: React.MouseEvent | React.KeyboardEvent,
      path: string,
      staged: boolean,
      sectionFiles: GitStatusDetail[]
    ) => {
      handleFileClick(e, path, staged, sectionFiles)
      if (e.shiftKey || e.ctrlKey || e.metaKey) return
      addDiffTab(cwd, path, staged)
    },
    [handleFileClick, addDiffTab, cwd]
  )

  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-background overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <GitPanelHeader
          variant="column"
          branches={branches}
          currentBranch={commitContext?.branch}
          hasUncommittedChanges={hasUncommittedChanges}
          isGenerating={isGenerating}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          onCreateBranch={() => setIsCreateBranchOpen(true)}
          onSwitchBranch={handleSwitchBranch}
          onOpenStash={() => setIsStashOpen(true)}
          belowBranch={
            <CommitComposer
              summary={summary}
              onSummaryChange={setSummary}
              description={description}
              onDescriptionChange={setDescription}
              amend={amend}
              onToggleAmend={handleToggleAmend}
              isCommitting={isCommitting}
              isGenerating={isGenerating}
              isPushing={isPushing}
              commitContext={commitContext}
              stagedCount={stagedCount}
              hasUsableAgent={hasUsableAgent}
              canGenerate={canGenerate}
              canCommit={canCommit}
              onGenerateMessage={handleGenerateMessage}
              onCommit={handleCommit}
              onPush={handlePush}
            />
          }
        />

        <GitChangeList
          variant="column"
          stagedFiles={stagedFiles}
          unstagedFiles={unstagedFiles}
          stashes={stashes}
          selectedFile={selectedFile}
          selectedStaged={selectedStaged}
          selectionSection={selectionSection}
          selectedPaths={selectedPaths}
          stagedSelectionCount={stagedSelectionCount}
          unstagedSelectionCount={unstagedSelectionCount}
          isMutating={isMutating}
          isGenerating={isGenerating}
          onFileClick={onFileClick}
          targetsFor={targetsFor}
          runStage={runStage}
          runUnstage={runUnstage}
          requestDiscard={requestDiscard}
          onApplyStash={handleApplyStash}
          onPopStash={handlePopStash}
          onDropStash={handleDropStash}
        />
      </div>

      <HistoryRow cwd={cwd} isVisible={isVisible} />

      <GitPanelDialogs actions={actions} />
    </div>
  )
}
