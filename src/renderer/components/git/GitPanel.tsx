import { useEffect, useState } from 'react'
import { CommitComposer } from '@/components/git/CommitComposer'
import { GitChangeList } from '@/components/git/GitChangeList'
import { GitDiffPane } from '@/components/git/GitDiffPane'
import { GitPanelDialogs } from '@/components/git/GitPanelDialogs'
import { GitPanelHeader } from '@/components/git/GitPanelHeader'
import { useGitActions } from '@/components/git/use-git-actions'
import { useGitPanelModel } from '@/components/git/use-git-panel-model'
import { useGitSelection } from '@/components/git/use-git-selection'
import { GitBranch } from '@/components/icons'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { type GitDiffViewMode, loadGitDiffViewMode } from '@/lib/parse-unified-diff'
import { cn } from '@/lib/utils'
import { diffKey, useGitStatusStore } from '@/stores/git-status-store'

interface GitPanelProps {
  cwd: string
  isVisible: boolean
}

export function GitPanel({ cwd, isVisible }: GitPanelProps) {
  const diffs = useGitStatusStore((state) => state.diffs)
  const setSelectedFile = useGitStatusStore((state) => state.setSelectedFile)
  const fetchDiff = useGitStatusStore((state) => state.fetchDiff)

  // Store wiring (refresh while visible, branches, stashes, filter query and
  // the filtered staged / unstaged lists) is shared with the shell Changes panel.
  const {
    selectedFile,
    stashes,
    branches,
    searchQuery,
    setSearchQuery,
    stagedFiles,
    unstagedFiles
  } = useGitPanelModel({ cwd, isVisible })

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
    if (!isVisible || !selectedFile) {
      return
    }

    const key = diffKey(cwd, selectedFile, selectedStaged)
    if (!Object.prototype.hasOwnProperty.call(diffs, key)) {
      fetchDiff(cwd, selectedFile, selectedStaged)
    }
  }, [isVisible, selectedFile, selectedStaged, cwd, diffs, fetchDiff])

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

  // Story 10: the mobile web shell (≤767px) swaps in touch-sized controls and a
  // full-width column; desktop keeps the dense 320px sidebar.
  const isMobile = useMobileWebShell()
  const variant = isMobile ? ('mobile' as const) : ('desktop' as const)

  // Mobile stacks a single panel: the store's `selectedFile` doubles as the
  // stack pointer (file list when null, diff view + back button when set).
  // Desktop shows both columns side by side. Dialogs stay mounted at the root
  // across the mobile swap.
  return (
    <div className="flex h-full w-full bg-background overflow-hidden">
      {(!isMobile || !selectedFile) && (
        <div
          className={cn(
            'flex shrink-0 flex-col',
            isMobile ? 'w-full' : 'w-80 border-r border-border'
          )}
        >
          <GitPanelHeader
            variant={variant}
            branches={branches}
            currentBranch={commitContext?.branch}
            ahead={commitContext?.ahead ?? 0}
            hasUncommittedChanges={hasUncommittedChanges}
            isGenerating={isGenerating}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            onCreateBranch={() => setIsCreateBranchOpen(true)}
            onSwitchBranch={handleSwitchBranch}
            onOpenStash={() => setIsStashOpen(true)}
          />

          <GitChangeList
            variant={variant}
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
            variant={isMobile ? 'mobile' : undefined}
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

      {(!isMobile || selectedFile) && (
        <div className="flex min-w-0 flex-1 flex-col bg-card/30">
          {selectedFile ? (
            <GitDiffPane
              variant={variant}
              selectedFile={selectedFile}
              selectedStaged={selectedStaged}
              currentDiff={currentDiff}
              diffViewMode={diffViewMode}
              onDiffViewModeChange={setDiffViewMode}
              onStageHunk={runStageHunk}
              onUnstageHunk={runUnstageHunk}
              onBack={isMobile ? () => setSelectedFile(null) : undefined}
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
      )}

      <GitPanelDialogs actions={actions} />
    </div>
  )
}
