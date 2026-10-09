import type { GitStatusDetail } from '@shared/types/ipc.types'
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import {
  BranchSection,
  BranchSwitchDialog,
  CreateBranchDialog
} from '@/components/git/BranchSection'
import { AmendCommitDialog, CommitComposer } from '@/components/git/CommitComposer'
import { GitDiffView } from '@/components/git/GitDiffView'
import { FileItem, RowAction, SectionAction, SectionHeader } from '@/components/git/rows'
import { StashDialog, StashSection } from '@/components/git/StashSection'
import { useGitActions } from '@/components/git/use-git-actions'
import {
  AlignLeft,
  Archive,
  ChevronLeft,
  Columns2,
  FileCode,
  FileText,
  GitBranch,
  Minus,
  Plus,
  RotateCcw,
  Search
} from '@/components/icons'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import {
  type GitDiffViewMode,
  loadGitDiffViewMode,
  saveGitDiffViewMode
} from '@/lib/parse-unified-diff'
import { diffKey, useGitStatusStore } from '@/stores/git-status-store'

interface GitPanelProps {
  cwd: string
  isVisible: boolean
}

type Section = 'staged' | 'unstaged'

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
  // Track which side (staged vs unstaged) of the selected path is shown, since
  // an `MM` file appears in both sections under the same path.
  const [selectedStaged, setSelectedStaged] = useState(false)

  // Multi-selection model. Selection is scoped to a single section (staged or
  // unstaged), since the same path can exist in both and they are staged /
  // unstaged independently. `anchorPath` is the pivot for shift-range selects.
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [selectionSection, setSelectionSection] = useState<Section | null>(null)
  const [anchorPath, setAnchorPath] = useState<string | null>(null)

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

  const clearSelection = useCallback(() => {
    setSelectedPaths(new Set())
    setSelectionSection(null)
    setAnchorPath(null)
  }, [])

  // Click selection with VSCode-style modifiers:
  // - plain click  → select only this row
  // - ctrl/cmd     → toggle this row in the selection
  // - shift        → select the contiguous range from the anchor
  // Selection is always scoped to the clicked row's section.
  const handleFileClick = useCallback(
    (
      e: React.MouseEvent | React.KeyboardEvent,
      path: string,
      staged: boolean,
      sectionFiles: GitStatusDetail[]
    ) => {
      const section: Section = staged ? 'staged' : 'unstaged'
      const sameSection = selectionSection === section

      if (e.shiftKey && sameSection && anchorPath) {
        const paths = sectionFiles.map((f) => f.path)
        const a = paths.indexOf(anchorPath)
        const b = paths.indexOf(path)
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a]
          setSelectedPaths(new Set(paths.slice(lo, hi + 1)))
          setSelectionSection(section)
        }
      } else if (e.ctrlKey || e.metaKey) {
        const next = new Set(sameSection ? selectedPaths : [])
        if (next.has(path)) {
          next.delete(path)
        } else {
          next.add(path)
        }
        setSelectedPaths(next)
        setSelectionSection(next.size > 0 ? section : null)
        setAnchorPath(path)
      } else {
        setSelectedPaths(new Set([path]))
        setSelectionSection(section)
        setAnchorPath(path)
      }

      // The diff view always follows the most-recently clicked row.
      setSelectedFile(path)
      setSelectedStaged(staged)
    },
    [selectionSection, selectedPaths, anchorPath, setSelectedFile]
  )

  // Resolve the paths an inline row action should affect: when the row is part
  // of an active multi-selection in its section, act on the whole selection;
  // otherwise act on just that row.
  const targetsFor = useCallback(
    (path: string, section: Section): string[] => {
      if (selectionSection === section && selectedPaths.size > 0 && selectedPaths.has(path)) {
        return [...selectedPaths]
      }
      return [path]
    },
    [selectionSection, selectedPaths]
  )

  // Git mutations (stage/unstage/discard, per-hunk apply, commit + AI message
  // generation, push, stash and branch ops) live in the useGitActions hook; it
  // owns the busy flags, the commit composer fields and the dialog state, and
  // resets the commit footer + multi-selection when cwd changes.
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
    summary,
    setSummary,
    description,
    setDescription,
    amend,
    isCommitting,
    isGenerating,
    isPushing,
    confirmAmendOpen,
    setConfirmAmendOpen,
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
    confirmDiscard,
    handleToggleAmend,
    handleGenerateMessage,
    runCommit,
    handleCommit,
    handlePush,
    handleSwitchBranch,
    handleExecuteSwitchBranch,
    handleCreateBranch,
    handleStashSave,
    handleApplyStash,
    handlePopStash,
    handleDropStash
  } = useGitActions({ cwd, setSelectedStaged, clearSelection })

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
            {/* pr-14 reserves the sheet close target (absolute, top-right, 44px on
                coarse pointers) so it never covers the header's right edge. */}
            <div className="border-b border-border bg-background p-2 pr-14 flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                size="touch"
                className="shrink-0"
                aria-label="Back to file list"
                onClick={() => setSelectedFile(null)}
              >
                <ChevronLeft size={18} />
              </Button>
              <div className="flex items-center gap-3 overflow-hidden min-w-0">
                <FileCode size={16} className="text-primary shrink-0" />
                <span className="text-sm font-medium truncate">{selectedFile}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <div
                  className="flex items-center rounded-md border border-border p-0.5"
                  role="group"
                  aria-label="Diff view mode"
                >
                  <Button
                    type="button"
                    variant={diffViewMode === 'inline' ? 'secondary' : 'ghost'}
                    size="touch"
                    className="min-h-9 min-w-9"
                    title="Inline diff"
                    aria-pressed={diffViewMode === 'inline'}
                    onClick={() => {
                      setDiffViewMode('inline')
                      saveGitDiffViewMode('inline')
                    }}
                  >
                    <AlignLeft size={16} />
                  </Button>
                  <Button
                    type="button"
                    variant={diffViewMode === 'split' ? 'secondary' : 'ghost'}
                    size="touch"
                    className="min-h-9 min-w-9"
                    title="Side-by-side diff"
                    aria-pressed={diffViewMode === 'split'}
                    onClick={() => {
                      setDiffViewMode('split')
                      saveGitDiffViewMode('split')
                    }}
                  >
                    <Columns2 size={16} />
                  </Button>
                </div>
                <span className="label-group text-muted-foreground">
                  {selectedStaged ? 'Staged' : 'Working tree'}
                </span>
              </div>
            </div>
            <ScrollArea className="flex-1 font-mono text-xs">
              {currentDiff === undefined || currentDiff === null ? (
                <div className="h-full flex items-center justify-center text-muted-foreground">
                  <Spinner size={16} decorative className="mr-2" />
                  Loading diff...
                </div>
              ) : currentDiff.trim().length > 0 ? (
                <GitDiffView
                  diff={currentDiff}
                  mode={diffViewMode}
                  filePath={selectedFile ?? undefined}
                  diffSide={selectedStaged ? 'staged' : 'unstaged'}
                  onStageHunk={runStageHunk}
                  onUnstageHunk={runUnstageHunk}
                />
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-8 text-center">
                  <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center mb-3 text-muted-foreground/60">
                    <FileText size={18} />
                  </div>
                  <h3 className="text-sm font-medium text-foreground mb-1">No diff available</h3>
                  <p className="text-xs max-w-[260px]">
                    This file may be ignored by Git, unchanged relative to the selected base, or
                    unavailable for diff preview.
                  </p>
                </div>
              )}
            </ScrollArea>
          </div>
        ) : (
          <div className="flex w-full flex-col shrink-0">
            {/* pr-14 reserves the sheet close target so it does not overlap the
                Stash changes button at the right edge of the first row. */}
            <div className="p-2 pr-14 border-b border-border flex flex-col gap-2 bg-muted/20">
              <div className="flex items-center justify-between">
                <BranchSection
                  variant="mobile"
                  branches={branches}
                  currentBranch={commitContext?.branch}
                  onCreateBranch={() => setIsCreateBranchOpen(true)}
                  onSwitchBranch={handleSwitchBranch}
                />

                <Button
                  variant="ghost"
                  size="touch"
                  className="w-11 text-muted-foreground hover:text-foreground hover:bg-secondary"
                  title="Stash changes"
                  onClick={() => setIsStashOpen(true)}
                  disabled={!hasUncommittedChanges || isGenerating}
                >
                  <Archive size={16} />
                </Button>
              </div>

              <div className="relative">
                <Search
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                  size={14}
                />
                <input
                  type="text"
                  placeholder="Filter changes..."
                  className="w-full bg-secondary/50 border-none rounded-md py-2.5 pl-8 pr-3 text-xs focus:ring-1 focus:ring-primary outline-none"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
            </div>

            <ScrollArea className="flex-1 w-full">
              <div className="p-2 pr-3 space-y-4 w-full">
                {stagedFiles.length > 0 && (
                  <div className="space-y-1">
                    <SectionHeader
                      label="Staged Changes"
                      count={stagedFiles.length}
                      selectionCount={stagedSelectionCount}
                    >
                      <SectionAction
                        icon={<Minus size={13} />}
                        label="Unstage all changes"
                        disabled={isMutating || isGenerating}
                        onClick={() => runUnstage(stagedFiles.map((f) => f.path))}
                      />
                    </SectionHeader>
                    {stagedFiles.map((file: GitStatusDetail) => {
                      const inSelection =
                        selectionSection === 'staged' && selectedPaths.has(file.path)
                      return (
                        <FileItem
                          key={file.path}
                          file={file}
                          variant="mobile"
                          isActive={selectedFile === file.path && selectedStaged}
                          isSelected={inSelection}
                          onClick={(e) => handleFileClick(e, file.path, true, stagedFiles)}
                        >
                          <RowAction
                            icon={<Minus size={isMobileWebShell ? 16 : 13} />}
                            label="Unstage changes"
                            touch
                            disabled={isMutating || isGenerating}
                            onClick={() => runUnstage(targetsFor(file.path, 'staged'))}
                          />
                        </FileItem>
                      )
                    })}
                  </div>
                )}

                <div className="space-y-1">
                  <SectionHeader
                    label="Changes"
                    count={unstagedFiles.length}
                    selectionCount={unstagedSelectionCount}
                  >
                    {unstagedFiles.length > 0 && (
                      <>
                        <SectionAction
                          icon={<RotateCcw size={13} />}
                          label="Discard all changes"
                          variant="danger"
                          disabled={isMutating || isGenerating}
                          onClick={() => requestDiscard(unstagedFiles.map((f) => f.path))}
                        />
                        <SectionAction
                          icon={<Plus size={13} />}
                          label="Stage all changes"
                          disabled={isMutating || isGenerating}
                          onClick={() => runStage(unstagedFiles.map((f) => f.path))}
                        />
                      </>
                    )}
                  </SectionHeader>
                  {unstagedFiles.length === 0 ? (
                    <div className="px-4 py-8 text-center">
                      <p className="text-xs text-muted-foreground">No changes detected</p>
                    </div>
                  ) : (
                    unstagedFiles.map((file: GitStatusDetail) => {
                      const inSelection =
                        selectionSection === 'unstaged' && selectedPaths.has(file.path)
                      return (
                        <FileItem
                          key={file.path}
                          file={file}
                          variant="mobile"
                          isActive={selectedFile === file.path && !selectedStaged}
                          isSelected={inSelection}
                          onClick={(e) => handleFileClick(e, file.path, false, unstagedFiles)}
                        >
                          <RowAction
                            icon={<RotateCcw size={isMobileWebShell ? 16 : 13} />}
                            label="Discard changes"
                            touch
                            variant="danger"
                            disabled={isMutating || isGenerating}
                            onClick={() => requestDiscard(targetsFor(file.path, 'unstaged'))}
                          />
                          <RowAction
                            icon={<Plus size={isMobileWebShell ? 16 : 13} />}
                            label="Stage changes"
                            touch
                            disabled={isMutating || isGenerating}
                            onClick={() => runStage(targetsFor(file.path, 'unstaged'))}
                          />
                        </FileItem>
                      )
                    })
                  )}
                </div>

                <StashSection
                  variant="mobile"
                  stashes={stashes}
                  isMutating={isMutating}
                  isGenerating={isGenerating}
                  onApply={handleApplyStash}
                  onPop={handlePopStash}
                  onDrop={handleDropStash}
                />
              </div>
            </ScrollArea>

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
      </div>
    )
  }

  return (
    <div className="flex h-full w-full bg-background overflow-hidden">
      {/* File List Sidebar */}
      <div className="w-80 border-r border-border flex flex-col shrink-0">
        <div className="p-3 border-b border-border flex flex-col gap-2 bg-muted/20">
          <div className="flex items-center justify-between">
            <BranchSection
              branches={branches}
              currentBranch={commitContext?.branch}
              onCreateBranch={() => setIsCreateBranchOpen(true)}
              onSwitchBranch={handleSwitchBranch}
            />

            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-secondary"
              title="Stash changes"
              onClick={() => setIsStashOpen(true)}
              disabled={!hasUncommittedChanges || isGenerating}
            >
              <Archive size={14} />
            </Button>
          </div>

          <div className="relative">
            <Search
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              size={14}
            />
            <input
              type="text"
              placeholder="Filter changes..."
              className="w-full bg-secondary/50 border-none rounded-md py-1.5 pl-8 pr-3 text-xs focus:ring-1 focus:ring-primary outline-none"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        <ScrollArea className="flex-1 w-full">
          <div className="p-2 pr-3 space-y-4 w-[303px]">
            {stagedFiles.length > 0 && (
              <div className="space-y-1">
                <SectionHeader
                  label="Staged Changes"
                  count={stagedFiles.length}
                  selectionCount={stagedSelectionCount}
                >
                  <SectionAction
                    icon={<Minus size={13} />}
                    label="Unstage all changes"
                    disabled={isMutating || isGenerating}
                    onClick={() => runUnstage(stagedFiles.map((f) => f.path))}
                  />
                </SectionHeader>
                {stagedFiles.map((file: GitStatusDetail) => {
                  const inSelection = selectionSection === 'staged' && selectedPaths.has(file.path)
                  return (
                    <FileItem
                      key={file.path}
                      file={file}
                      isActive={selectedFile === file.path && selectedStaged}
                      isSelected={inSelection}
                      onClick={(e) => handleFileClick(e, file.path, true, stagedFiles)}
                    >
                      <RowAction
                        icon={<Minus size={13} />}
                        label="Unstage changes"
                        disabled={isMutating || isGenerating}
                        onClick={() => runUnstage(targetsFor(file.path, 'staged'))}
                      />
                    </FileItem>
                  )
                })}
              </div>
            )}

            <div className="space-y-1">
              <SectionHeader
                label="Changes"
                count={unstagedFiles.length}
                selectionCount={unstagedSelectionCount}
              >
                {unstagedFiles.length > 0 && (
                  <>
                    <SectionAction
                      icon={<RotateCcw size={13} />}
                      label="Discard all changes"
                      variant="danger"
                      disabled={isMutating || isGenerating}
                      onClick={() => requestDiscard(unstagedFiles.map((f) => f.path))}
                    />
                    <SectionAction
                      icon={<Plus size={13} />}
                      label="Stage all changes"
                      disabled={isMutating || isGenerating}
                      onClick={() => runStage(unstagedFiles.map((f) => f.path))}
                    />
                  </>
                )}
              </SectionHeader>
              {unstagedFiles.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-xs text-muted-foreground">No changes detected</p>
                </div>
              ) : (
                unstagedFiles.map((file: GitStatusDetail) => {
                  const inSelection =
                    selectionSection === 'unstaged' && selectedPaths.has(file.path)
                  return (
                    <FileItem
                      key={file.path}
                      file={file}
                      isActive={selectedFile === file.path && !selectedStaged}
                      isSelected={inSelection}
                      onClick={(e) => handleFileClick(e, file.path, false, unstagedFiles)}
                    >
                      <RowAction
                        icon={<RotateCcw size={13} />}
                        label="Discard changes"
                        variant="danger"
                        disabled={isMutating || isGenerating}
                        onClick={() => requestDiscard(targetsFor(file.path, 'unstaged'))}
                      />
                      <RowAction
                        icon={<Plus size={13} />}
                        label="Stage changes"
                        disabled={isMutating || isGenerating}
                        onClick={() => runStage(targetsFor(file.path, 'unstaged'))}
                      />
                    </FileItem>
                  )
                })
              )}
            </div>

            <StashSection
              stashes={stashes}
              isMutating={isMutating}
              isGenerating={isGenerating}
              onApply={handleApplyStash}
              onPop={handlePopStash}
              onDrop={handleDropStash}
            />
          </div>
        </ScrollArea>

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
          <>
            <div className="p-3 border-b border-border flex items-center justify-between gap-2 bg-background">
              <div className="flex items-center gap-3 overflow-hidden min-w-0">
                <FileCode size={16} className="text-primary shrink-0" />
                <span className="text-sm font-medium truncate">{selectedFile}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <div
                  className="flex items-center rounded-md border border-border p-0.5"
                  role="group"
                  aria-label="Diff view mode"
                >
                  <Button
                    type="button"
                    variant={diffViewMode === 'inline' ? 'secondary' : 'ghost'}
                    size="icon"
                    className="h-7 w-7"
                    title="Inline diff"
                    aria-pressed={diffViewMode === 'inline'}
                    onClick={() => {
                      setDiffViewMode('inline')
                      saveGitDiffViewMode('inline')
                    }}
                  >
                    <AlignLeft size={14} />
                  </Button>
                  <Button
                    type="button"
                    variant={diffViewMode === 'split' ? 'secondary' : 'ghost'}
                    size="icon"
                    className="h-7 w-7"
                    title="Side-by-side diff"
                    aria-pressed={diffViewMode === 'split'}
                    onClick={() => {
                      setDiffViewMode('split')
                      saveGitDiffViewMode('split')
                    }}
                  >
                    <Columns2 size={14} />
                  </Button>
                </div>
                <span className="label-group text-muted-foreground">
                  {selectedStaged ? 'Staged' : 'Working tree'}
                </span>
              </div>
            </div>
            <ScrollArea className="flex-1 font-mono text-xs">
              {currentDiff === undefined || currentDiff === null ? (
                <div className="h-full flex items-center justify-center text-muted-foreground">
                  <Spinner size={16} decorative className="mr-2" />
                  Loading diff...
                </div>
              ) : currentDiff.trim().length > 0 ? (
                <GitDiffView
                  diff={currentDiff}
                  mode={diffViewMode}
                  filePath={selectedFile ?? undefined}
                  diffSide={selectedStaged ? 'staged' : 'unstaged'}
                  onStageHunk={runStageHunk}
                  onUnstageHunk={runUnstageHunk}
                />
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-8 text-center">
                  <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center mb-3 text-muted-foreground/60">
                    <FileText size={18} />
                  </div>
                  <h3 className="text-sm font-medium text-foreground mb-1">No diff available</h3>
                  <p className="text-xs max-w-[260px]">
                    This file may be ignored by Git, unchanged relative to the selected base, or
                    unavailable for diff preview.
                  </p>
                </div>
              )}
            </ScrollArea>
          </>
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
    </div>
  )
}
