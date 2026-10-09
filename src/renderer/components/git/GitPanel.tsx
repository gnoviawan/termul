import type { GitStatusDetail } from '@shared/types/ipc.types'
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { BranchSection } from '@/components/git/BranchSection'
import { CommitComposer } from '@/components/git/CommitComposer'
import { DiffPane } from '@/components/git/DiffPane'
import { GitPanelDialogs } from '@/components/git/GitPanelDialogs'
import {
  ChangesFilter,
  FileItem,
  RowAction,
  SectionAction,
  SectionHeader
} from '@/components/git/rows'
import { StashSection } from '@/components/git/StashSection'
import { useGitActions } from '@/components/git/use-git-actions'
import { Archive, GitBranch, Minus, Plus, RotateCcw } from '@/components/icons'
import { QUIET_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import {
  type GitDiffViewMode,
  loadGitDiffViewMode,
  saveGitDiffViewMode
} from '@/lib/parse-unified-diff'
import { cn } from '@/lib/utils'
import { diffKey, useGitStatusStore } from '@/stores/git-status-store'

interface GitPanelProps {
  cwd: string
  isVisible: boolean
}

type Section = 'staged' | 'unstaged'

/**
 * Story 10: the mobile web shell (≤767px) swaps in touch-sized controls and a
 * full-width column; desktop keeps the dense 320px sidebar.
 */
const LIST_CHROME = {
  desktop: {
    column: 'w-80 border-r border-border',
    header: 'h-10 pl-2 pr-1.5',
    list: 'w-[312px]',
    stashButton: 'size-7',
    stashIcon: 14,
    rowIcon: 13
  },
  mobile: {
    column: 'w-full',
    header: 'min-h-14 pl-1 pr-1',
    list: 'w-full',
    stashButton: 'size-11',
    stashIcon: 16,
    rowIcon: 16
  }
} as const

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

  const isMobile = useMobileWebShell()
  const variant = isMobile ? ('mobile' as const) : undefined
  const chrome = LIST_CHROME[variant ?? 'desktop']

  const handleDiffViewModeChange = (mode: GitDiffViewMode) => {
    setDiffViewMode(mode)
    saveGitDiffViewMode(mode)
  }

  const busy = isMutating || isGenerating
  const ahead = commitContext?.ahead ?? 0

  // File list column (branch header, filter, Staged / Changes sections,
  // stashes, commit composer). Mobile and desktop share this markup.
  const fileList = (
    <>
      <div className={cn('flex shrink-0 items-center gap-1', chrome.header)}>
        {/* BranchSection's trigger carries its own px-2, so pl-2 here puts
              the branch icon on the 16px panel inset. */}
        <BranchSection
          variant={variant}
          branches={branches}
          currentBranch={commitContext?.branch}
          onCreateBranch={() => setIsCreateBranchOpen(true)}
          onSwitchBranch={handleSwitchBranch}
        />
        {ahead > 0 && (
          <span
            className="shrink-0 text-2xs tabular-nums text-muted-foreground"
            title={`${ahead} commit${ahead === 1 ? '' : 's'} ahead of upstream`}
          >
            ↑{ahead}
          </span>
        )}
        <button
          type="button"
          className={cn(
            QUIET_ICON_BUTTON_CLASS,
            'ml-auto flex shrink-0 disabled:cursor-not-allowed disabled:opacity-40',
            chrome.stashButton
          )}
          title="Stash changes"
          aria-label="Stash changes"
          onClick={() => setIsStashOpen(true)}
          disabled={!hasUncommittedChanges || isGenerating}
        >
          <Archive size={chrome.stashIcon} />
        </button>
      </div>

      <div className="shrink-0 px-2 pb-2">
        <ChangesFilter value={searchQuery} onChange={setSearchQuery} variant={variant} />
      </div>

      <ScrollArea className="flex-1 w-full">
        <div className={cn('space-y-2 px-2 pb-2', chrome.list)}>
          {stagedFiles.length > 0 && (
            <div>
              <SectionHeader
                label="Staged"
                count={stagedFiles.length}
                selectionCount={stagedSelectionCount}
              >
                <SectionAction
                  icon={<Minus size={13} />}
                  label="Unstage all changes"
                  disabled={busy}
                  onClick={() => runUnstage(stagedFiles.map((f) => f.path))}
                />
              </SectionHeader>
              {stagedFiles.map((file: GitStatusDetail) => (
                <FileItem
                  key={file.path}
                  file={file}
                  variant={variant}
                  isActive={selectedFile === file.path && selectedStaged}
                  isSelected={selectionSection === 'staged' && selectedPaths.has(file.path)}
                  onClick={(e) => handleFileClick(e, file.path, true, stagedFiles)}
                >
                  <RowAction
                    icon={<Minus size={chrome.rowIcon} />}
                    label="Unstage changes"
                    touch={isMobile}
                    disabled={busy}
                    onClick={() => runUnstage(targetsFor(file.path, 'staged'))}
                  />
                </FileItem>
              ))}
            </div>
          )}

          <div>
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
                    disabled={busy}
                    onClick={() => requestDiscard(unstagedFiles.map((f) => f.path))}
                  />
                  <SectionAction
                    icon={<Plus size={13} />}
                    label="Stage all changes"
                    disabled={busy}
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
              unstagedFiles.map((file: GitStatusDetail) => (
                <FileItem
                  key={file.path}
                  file={file}
                  variant={variant}
                  isActive={selectedFile === file.path && !selectedStaged}
                  isSelected={selectionSection === 'unstaged' && selectedPaths.has(file.path)}
                  onClick={(e) => handleFileClick(e, file.path, false, unstagedFiles)}
                >
                  <RowAction
                    icon={<RotateCcw size={chrome.rowIcon} />}
                    label="Discard changes"
                    touch={isMobile}
                    variant="danger"
                    disabled={busy}
                    onClick={() => requestDiscard(targetsFor(file.path, 'unstaged'))}
                  />
                  <RowAction
                    icon={<Plus size={chrome.rowIcon} />}
                    label="Stage changes"
                    touch={isMobile}
                    disabled={busy}
                    onClick={() => runStage(targetsFor(file.path, 'unstaged'))}
                  />
                </FileItem>
              ))
            )}
          </div>

          <StashSection
            variant={variant}
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
        variant={variant}
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
    </>
  )

  // Mobile stacks a single panel: the store's `selectedFile` doubles as the
  // stack pointer (file list when null, diff view + back button when set).
  // Desktop shows both columns side by side. Dialogs stay mounted at the root
  // across the mobile swap.
  return (
    <div className="flex h-full w-full bg-background overflow-hidden">
      {(!isMobile || !selectedFile) && (
        <div className={cn('flex shrink-0 flex-col', chrome.column)}>{fileList}</div>
      )}

      {(!isMobile || selectedFile) && (
        <div className="flex min-w-0 flex-1 flex-col bg-card/30">
          {selectedFile ? (
            <DiffPane
              variant={variant}
              selectedFile={selectedFile}
              selectedStaged={selectedStaged}
              currentDiff={currentDiff}
              diffViewMode={diffViewMode}
              onDiffViewModeChange={handleDiffViewModeChange}
              onBack={isMobile ? () => setSelectedFile(null) : undefined}
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
      )}

      <GitPanelDialogs actions={actions} />
    </div>
  )
}
