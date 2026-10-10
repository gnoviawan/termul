import type { GitStatusDetail } from '@shared/types/ipc.types'
import { useEffect, useMemo, useState } from 'react'
import { CommitComposer } from '@/components/git/CommitComposer'
import { GitChangeList } from '@/components/git/GitChangeList'
import { GitDiffPane } from '@/components/git/GitDiffPane'
import { GitPanelDialogs } from '@/components/git/GitPanelDialogs'
import { GitPanelHeader } from '@/components/git/GitPanelHeader'
import { useGitActions } from '@/components/git/use-git-actions'
import { useGitSelection } from '@/components/git/use-git-selection'
import { GitBranch } from '@/components/icons'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { type GitDiffViewMode, loadGitDiffViewMode } from '@/lib/parse-unified-diff'
import { diffKey, useGitStatusStore } from '@/stores/git-status-store'

interface GitPanelProps {
  cwd: string
  isVisible: boolean
}

export function GitPanel({ cwd, isVisible }: GitPanelProps) {
  const statuses = useGitStatusStore((state) => state.statuses)
  const diffs = useGitStatusStore((state) => state.diffs)
  const selectedFile = useGitStatusStore((state) => state.selectedFile)
  const setSelectedFile = useGitStatusStore((state) => state.setSelectedFile)
  const refreshStatus = useGitStatusStore((state) => state.refreshStatus)
  const fetchDiff = useGitStatusStore((state) => state.fetchDiff)
  const fetchCommitContext = useGitStatusStore((state) => state.fetchCommitContext)

  const stashesState = useGitStatusStore((state) => state.stashes)
  const branchesState = useGitStatusStore((state) => state.branches)
  const fetchStashes = useGitStatusStore((state) => state.fetchStashes)
  const fetchBranches = useGitStatusStore((state) => state.fetchBranches)

  const stashes = stashesState[cwd] ?? []
  const branches = branchesState[cwd] ?? []

  const [searchQuery, setSearchQuery] = useState('')
  // Multi-selection model (selected rows, section scope, anchor, and which side
  // — staged vs unstaged — of the selected path is shown).
  const {
    selectedStaged,
    setSelectedStaged,
    selectedPaths,
    selectionSection,
    clearSelection,
    handleFileClick,
    targetsFor
  } = useGitSelection()

  const [diffViewMode, setDiffViewMode] = useState<GitDiffViewMode>(loadGitDiffViewMode)

  const currentDiff = selectedFile ? diffs[diffKey(cwd, selectedFile, selectedStaged)] : null

  useEffect(() => {
    if (isVisible) {
      refreshStatus(cwd)
      fetchCommitContext(cwd)
      fetchStashes(cwd)
      fetchBranches(cwd)
    }
  }, [isVisible, cwd, refreshStatus, fetchCommitContext, fetchStashes, fetchBranches])

  useEffect(() => {
    if (!isVisible || !selectedFile) {
      return
    }

    const key = diffKey(cwd, selectedFile, selectedStaged)
    if (!Object.prototype.hasOwnProperty.call(diffs, key)) {
      fetchDiff(cwd, selectedFile, selectedStaged)
    }
  }, [isVisible, selectedFile, selectedStaged, cwd, diffs, fetchDiff])

  const filteredStatuses = useMemo(() => {
    const currentStatuses = statuses[cwd] || []
    if (!searchQuery) return currentStatuses
    return currentStatuses.filter((s: GitStatusDetail) =>
      s.path.toLowerCase().includes(searchQuery.toLowerCase())
    )
  }, [statuses, cwd, searchQuery])

  const { stagedFiles, unstagedFiles } = useMemo(() => {
    const staged = filteredStatuses.filter((s: GitStatusDetail) => s.staged)
    const unstaged = filteredStatuses.filter((s: GitStatusDetail) => !s.staged)
    return { stagedFiles: staged, unstagedFiles: unstaged }
  }, [filteredStatuses])

  // Git mutations (stage/unstage/discard, per-hunk apply, commit + AI message
  // generation, push, stash and branch ops) live in the useGitActions hook; it
  // owns the busy flags, the commit composer fields and the dialog state, and
  // resets the commit footer + multi-selection when cwd changes.
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
    runStageHunk,
    runUnstageHunk,
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

  const isMobileWebShell = useMobileWebShell()

  // Mobile web shell (≤767px): render a stacked single-panel layout instead
  // of the desktop two-column split. The store's `selectedFile` doubles as the
  // mobile stack pointer — file list when null, diff view + back button when
  // set. All handlers/selectors are reused unchanged; only the layout JSX and
  // the outer wrapper className (`w-full` vs `w-80 border-r`) differ. The
  // desktop return below this block is byte-identical to the pre-CAP-5 code.
  if (isMobileWebShell) {
    return (
      <div className="flex h-full w-full bg-background overflow-hidden">
        {selectedFile ? (
          <div className="flex w-full flex-col min-w-0 bg-card/30">
            <GitDiffPane
              variant="mobile"
              selectedFile={selectedFile}
              selectedStaged={selectedStaged}
              currentDiff={currentDiff}
              diffViewMode={diffViewMode}
              onDiffViewModeChange={setDiffViewMode}
              onStageHunk={runStageHunk}
              onUnstageHunk={runUnstageHunk}
              onBack={() => setSelectedFile(null)}
            />
          </div>
        ) : (
          <div className="flex w-full flex-col shrink-0">
            <GitPanelHeader
              variant="mobile"
              branches={branches}
              currentBranch={commitContext?.branch}
              hasUncommittedChanges={hasUncommittedChanges}
              isGenerating={isGenerating}
              searchQuery={searchQuery}
              onSearchQueryChange={setSearchQuery}
              onCreateBranch={() => setIsCreateBranchOpen(true)}
              onSwitchBranch={handleSwitchBranch}
              onOpenStash={() => setIsStashOpen(true)}
            />

            <GitChangeList
              variant="mobile"
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
              onFileClick={handleFileClick}
              targetsFor={targetsFor}
              runStage={runStage}
              runUnstage={runUnstage}
              requestDiscard={requestDiscard}
              onApplyStash={handleApplyStash}
              onPopStash={handlePopStash}
              onDropStash={handleDropStash}
            />

            <CommitComposer
              variant="mobile"
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
          </div>
        )}

        <GitPanelDialogs actions={actions} />
      </div>
    )
  }

  return (
    <div className="flex h-full w-full bg-background overflow-hidden">
      {/* File List Sidebar */}
      <div className="w-80 border-r border-border flex flex-col shrink-0">
        <GitPanelHeader
          variant="desktop"
          branches={branches}
          currentBranch={commitContext?.branch}
          hasUncommittedChanges={hasUncommittedChanges}
          isGenerating={isGenerating}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          onCreateBranch={() => setIsCreateBranchOpen(true)}
          onSwitchBranch={handleSwitchBranch}
          onOpenStash={() => setIsStashOpen(true)}
        />

        <GitChangeList
          variant="desktop"
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
          onFileClick={handleFileClick}
          targetsFor={targetsFor}
          runStage={runStage}
          runUnstage={runUnstage}
          requestDiscard={requestDiscard}
          onApplyStash={handleApplyStash}
          onPopStash={handlePopStash}
          onDropStash={handleDropStash}
        />

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
      </div>

      {/* Diff View */}
      <div className="flex-1 flex flex-col min-w-0 bg-card/30">
        {selectedFile ? (
          <GitDiffPane
            variant="desktop"
            selectedFile={selectedFile}
            selectedStaged={selectedStaged}
            currentDiff={currentDiff}
            diffViewMode={diffViewMode}
            onDiffViewModeChange={setDiffViewMode}
            onStageHunk={runStageHunk}
            onUnstageHunk={runUnstageHunk}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-8 text-center">
            <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center mb-4 text-muted-foreground/50">
              <GitBranch size={24} />
            </div>
            <h3 className="text-sm font-medium text-foreground mb-1">
              Select a file to see changes
            </h3>
            <p className="text-xs max-w-[240px]">
              Click on any modified file in the sidebar to view the diff and manage your changes.
            </p>
          </div>
        )}
      </div>

      <GitPanelDialogs actions={actions} />
    </div>
  )
}
