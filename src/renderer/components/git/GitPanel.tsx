import type { GitFileStatus, GitStatusDetail } from '@shared/types/ipc.types'
import {
  AlignLeft,
  Archive,
  ArchiveRestore,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ClipboardPaste,
  Columns2,
  FileCode,
  FileQuestion,
  FileText,
  GitBranch,
  GitCommit,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Trash2
} from 'lucide-react'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { GitDiffView } from '@/components/git/GitDiffView'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { formatNumber } from '@/i18n/format'
import { gitApi } from '@/lib/git-api'
import {
  type GitDiffViewMode,
  loadGitDiffViewMode,
  saveGitDiffViewMode
} from '@/lib/parse-unified-diff'
import { cn } from '@/lib/utils'
import { useAcpStore } from '@/stores/acp-store'
import { diffKey, useGitStatusStore } from '@/stores/git-status-store'

const MAX_COMMIT_MESSAGE_DIFF_CHARS = 120_000

interface GitPanelProps {
  cwd: string
  isVisible: boolean
}

type Section = 'staged' | 'unstaged'

export function GitPanel({ cwd, isVisible }: GitPanelProps) {
  const { t } = useTranslation('git')
  const statuses = useGitStatusStore((state) => state.statuses)
  const diffs = useGitStatusStore((state) => state.diffs)
  const selectedFile = useGitStatusStore((state) => state.selectedFile)
  const setSelectedFile = useGitStatusStore((state) => state.setSelectedFile)
  const refreshStatus = useGitStatusStore((state) => state.refreshStatus)
  const fetchDiff = useGitStatusStore((state) => state.fetchDiff)
  const stageFiles = useGitStatusStore((state) => state.stageFiles)
  const unstageFiles = useGitStatusStore((state) => state.unstageFiles)
  const discardFiles = useGitStatusStore((state) => state.discardFiles)
  const stageHunk = useGitStatusStore((state) => state.stageHunk)
  const unstageHunk = useGitStatusStore((state) => state.unstageHunk)
  const commitContexts = useGitStatusStore((state) => state.commitContexts)
  const fetchCommitContext = useGitStatusStore((state) => state.fetchCommitContext)
  const commit = useGitStatusStore((state) => state.commit)
  const push = useGitStatusStore((state) => state.push)
  const selectedAgentConfigId = useAcpStore((state) => state.selectedAgentConfigId)
  const agentConfigs = useAcpStore((state) => state.agentConfigs)
  const generateCommitMessage = useAcpStore((state) => state.generateCommitMessage)

  const stashesState = useGitStatusStore((state) => state.stashes)
  const branchesState = useGitStatusStore((state) => state.branches)
  const fetchStashes = useGitStatusStore((state) => state.fetchStashes)
  const fetchBranches = useGitStatusStore((state) => state.fetchBranches)
  const stashSave = useGitStatusStore((state) => state.stashSave)
  const stashApply = useGitStatusStore((state) => state.stashApply)
  const stashPop = useGitStatusStore((state) => state.stashPop)
  const stashDrop = useGitStatusStore((state) => state.stashDrop)
  const branchSwitch = useGitStatusStore((state) => state.branchSwitch)
  const branchCreate = useGitStatusStore((state) => state.branchCreate)

  const commitContext = commitContexts[cwd] ?? null
  const stashes = stashesState[cwd] ?? []
  const branches = branchesState[cwd] ?? []

  const [searchQuery, setSearchQuery] = useState('')
  // Track which side (staged vs unstaged) of the selected path is shown, since
  // an `MM` file appears in both sections under the same path.
  const [selectedStaged, setSelectedStaged] = useState(false)
  const [isMutating, setIsMutating] = useState(false)

  // Multi-selection model. Selection is scoped to a single section (staged or
  // unstaged), since the same path can exist in both and they are staged /
  // unstaged independently. `anchorPath` is the pivot for shift-range selects.
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [selectionSection, setSelectionSection] = useState<Section | null>(null)
  const [anchorPath, setAnchorPath] = useState<string | null>(null)

  // Discard is confirmed through the app dialog; remember what it targets.
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false)
  const [discardTargets, setDiscardTargets] = useState<string[]>([])

  // Create branch modal state
  const [isCreateBranchOpen, setIsCreateBranchOpen] = useState(false)
  const [branchNameInput, setBranchNameInput] = useState('')

  // Stash modal state
  const [isStashOpen, setIsStashOpen] = useState(false)
  const [stashMessage, setStashMessage] = useState('')
  const [stashIncludeUntracked, setStashIncludeUntracked] = useState(false)

  // Branch switch confirmation modal state
  const [confirmBranchSwitchOpen, setConfirmBranchSwitchOpen] = useState(false)
  const [pendingBranchName, setPendingBranchName] = useState('')

  // Commit footer state.
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [amend, setAmend] = useState(false)
  const [isCommitting, setIsCommitting] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isPushing, setIsPushing] = useState(false)
  const [confirmAmendOpen, setConfirmAmendOpen] = useState(false)
  const [diffViewMode, setDiffViewMode] = useState<GitDiffViewMode>(loadGitDiffViewMode)
  // Synchronous in-flight guard so a same-tick double-click cannot dispatch two
  // commits before the isCommitting state has re-rendered.
  const commitInFlight = React.useRef(false)
  const generationInFlight = React.useRef(false)
  // Synchronous guard for per-hunk stage/unstage: a fast second click on
  // another hunk would otherwise build a patch from the pre-mutation diff
  // and apply it at a shifted offset once `--recount` relaxes the header.
  const hunkInFlight = React.useRef(false)
  const generationToken = React.useRef(0)
  const currentCwd = React.useRef(cwd)
  const currentStatuses = React.useRef(statuses)

  const currentDiff = selectedFile ? diffs[diffKey(cwd, selectedFile, selectedStaged)] : null

  useEffect(() => {
    currentCwd.current = cwd
    currentStatuses.current = statuses
  }, [cwd, statuses])

  useEffect(() => {
    if (isVisible) {
      refreshStatus(cwd)
      fetchCommitContext(cwd)
      fetchStashes(cwd)
      fetchBranches(cwd)
    }
  }, [isVisible, cwd, refreshStatus, fetchCommitContext, fetchStashes, fetchBranches])

  // Reset the commit footer and any multi-selection when the repo (cwd) changes
  // so half-typed messages or stale selections never carry over between repos.
  // biome-ignore lint/correctness/useExhaustiveDependencies: cwd intentionally resets state when the repo changes
  useEffect(() => {
    generationToken.current += 1
    setSelectedFile(null)
    setSelectedStaged(false)
    setSummary('')
    setDescription('')
    setAmend(false)
    setConfirmAmendOpen(false)
    setSelectedPaths(new Set())
    setSelectionSection(null)
    setAnchorPath(null)
  }, [cwd, setSelectedFile])

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

  const allStatuses = statuses[cwd] ?? []
  const hasUncommittedChanges = allStatuses.length > 0

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

  const runStage = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0 || generationInFlight.current) return
      setIsMutating(true)
      try {
        await stageFiles(cwd, paths)
        clearSelection()
        if (selectedFile && paths.includes(selectedFile)) {
          setSelectedStaged(true)
        }
      } catch (error) {
        toast.error(t('errors.stageFailed', { details: String(error) }))
      } finally {
        setIsMutating(false)
      }
    },
    [cwd, stageFiles, clearSelection, selectedFile, t]
  )

  const runUnstage = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0 || generationInFlight.current) return
      setIsMutating(true)
      try {
        await unstageFiles(cwd, paths)
        clearSelection()
        if (selectedFile && paths.includes(selectedFile)) {
          setSelectedStaged(false)
        }
      } catch (error) {
        toast.error(t('errors.unstageFailed', { details: String(error) }))
      } finally {
        setIsMutating(false)
      }
    },
    [cwd, unstageFiles, clearSelection, selectedFile, t]
  )

  // Per-hunk stage/unstage (#257). The patch is built by GitDiffView from
  // the displayed diff and applied to the index without touching the rest
  // of the file. After mutation, fetchDiff re-loads the (now smaller) diff
  // so the panel reflects the partial stage.
  const runStageHunk = useCallback(
    async (patch: string) => {
      if (!selectedFile || generationInFlight.current || hunkInFlight.current) return
      hunkInFlight.current = true
      setIsMutating(true)
      try {
        await stageHunk(cwd, selectedFile, patch)
        await fetchDiff(cwd, selectedFile, false)
      } catch (error) {
        toast.error(t('errors.stageHunkFailed', { details: String(error) }))
      } finally {
        setIsMutating(false)
        hunkInFlight.current = false
      }
    },
    [cwd, selectedFile, stageHunk, fetchDiff, t]
  )

  const runUnstageHunk = useCallback(
    async (patch: string) => {
      if (!selectedFile || generationInFlight.current || hunkInFlight.current) return
      hunkInFlight.current = true
      setIsMutating(true)
      try {
        await unstageHunk(cwd, selectedFile, patch)
        await fetchDiff(cwd, selectedFile, true)
      } catch (error) {
        toast.error(t('errors.unstageHunkFailed', { details: String(error) }))
      } finally {
        setIsMutating(false)
        hunkInFlight.current = false
      }
    },
    [cwd, selectedFile, unstageHunk, fetchDiff, t]
  )

  // Discard only reverts unstaged (working-tree) changes, so it is only ever
  // offered for unstaged rows. Confirm before destroying work.
  const requestDiscard = useCallback((paths: string[]) => {
    if (paths.length === 0 || generationInFlight.current) return
    setDiscardTargets(paths)
    setConfirmDiscardOpen(true)
  }, [])

  const confirmDiscard = useCallback(async () => {
    if (discardTargets.length === 0 || generationInFlight.current) return
    setIsMutating(true)
    try {
      await discardFiles(cwd, discardTargets)
      if (selectedFile && discardTargets.includes(selectedFile)) {
        setSelectedFile(null)
        setSelectedStaged(false)
      }
      clearSelection()
    } catch (error) {
      toast.error(t('errors.discardFailed', { details: String(error) }))
    } finally {
      setIsMutating(false)
      setConfirmDiscardOpen(false)
      setDiscardTargets([])
    }
  }, [cwd, discardTargets, discardFiles, selectedFile, setSelectedFile, clearSelection, t])

  // Toggling amend on prefills the message from the last commit so the user can
  // reword it — but only when the inputs are empty, so we never clobber text the
  // user already typed. Toggling off clears a prefill that the user did not edit.
  const handleToggleAmend = () => {
    if (generationInFlight.current) return
    const next = !amend
    setAmend(next)
    if (next && commitContext?.hasHead) {
      if (summary.trim() === '' && description.trim() === '') {
        setSummary(commitContext.lastSubject)
        setDescription(commitContext.lastBody)
      }
    } else if (!next) {
      // Only auto-clear if the inputs still match the prefilled last commit
      // (i.e. the user did not type their own message over it).
      if (
        summary === (commitContext?.lastSubject ?? '') &&
        description === (commitContext?.lastBody ?? '')
      ) {
        setSummary('')
        setDescription('')
      }
    }
  }

  const stagedCount = commitContext?.stagedCount ?? 0
  const hasUsableAgent =
    selectedAgentConfigId !== null &&
    agentConfigs.some((config) => config.id === selectedAgentConfigId)
  const canGenerate = stagedCount > 0 && !isGenerating && !isCommitting && !isPushing && !isMutating
  const canCommit =
    summary.trim().length > 0 &&
    !isCommitting &&
    !isGenerating &&
    !isPushing &&
    (amend ? !!commitContext?.hasHead : stagedCount > 0)

  const handleGenerateMessage = async () => {
    if (
      generationInFlight.current ||
      commitInFlight.current ||
      isCommitting ||
      isPushing ||
      isMutating
    ) {
      return
    }
    if (!hasUsableAgent) {
      toast.error(t('commit.errors.agentRequired'))
      return
    }
    if (stagedCount === 0) {
      toast.error(t('commit.errors.stageRequired'))
      return
    }

    generationInFlight.current = true
    const requestedCwd = cwd
    const requestedToken = ++generationToken.current
    setIsGenerating(true)
    try {
      const paths = [
        ...new Set(
          (statuses[cwd] ?? []).filter((status) => status.staged).map((status) => status.path)
        )
      ]
      if (paths.length !== stagedCount) {
        throw new Error(t('commit.errors.stagedFilesChanged'))
      }
      const sections = await Promise.all(
        paths.map(async (path) => ({ path, diff: await gitApi.getDiff(requestedCwd, path, true) }))
      )
      const latestPaths = [
        ...new Set(
          (currentStatuses.current[requestedCwd] ?? [])
            .filter((status) => status.staged)
            .map((status) => status.path)
        )
      ]
      const sortedPaths = [...paths].sort()
      const sortedLatestPaths = [...latestPaths].sort()
      if (
        currentCwd.current !== requestedCwd ||
        generationToken.current !== requestedToken ||
        sortedLatestPaths.length !== sortedPaths.length ||
        sortedLatestPaths.some((path, index) => path !== sortedPaths[index])
      ) {
        throw new Error(t('commit.errors.generationChanged'))
      }
      const stagedDiff = sections
        .filter(({ diff }) => diff.trim().length > 0)
        .map(
          ({ path, diff }) =>
            `--- BEGIN STAGED FILE: ${path} ---\n${diff}\n--- END STAGED FILE: ${path} ---`
        )
        .join('\n\n')
        .trim()
      if (stagedDiff.length === 0) {
        throw new Error(t('commit.errors.emptyDiff'))
      }
      if (stagedDiff.length > MAX_COMMIT_MESSAGE_DIFF_CHARS) {
        throw new Error(
          t('commit.errors.diffTooLarge', {
            count: stagedDiff.length,
            formattedCount: formatNumber(stagedDiff.length),
            formattedLimit: formatNumber(MAX_COMMIT_MESSAGE_DIFF_CHARS)
          })
        )
      }
      const generated = await generateCommitMessage(requestedCwd, stagedDiff)
      if (currentCwd.current !== requestedCwd || generationToken.current !== requestedToken) {
        throw new Error(t('commit.errors.repositoryChanged'))
      }
      setSummary(generated.summary)
      setDescription(generated.description)
      toast.success(t('commit.toasts.generated'))
    } catch (error) {
      toast.error(String(error instanceof Error ? error.message : error))
    } finally {
      setIsGenerating(false)
      generationInFlight.current = false
    }
  }

  const runCommit = async () => {
    if (commitInFlight.current || generationInFlight.current) return
    commitInFlight.current = true
    setIsCommitting(true)
    try {
      await commit(cwd, summary, description, amend)
      setSummary('')
      setDescription('')
      setAmend(false)
      toast.success(amend ? t('commit.toasts.amended') : t('commit.toasts.committed'))
    } catch (error) {
      toast.error(t('commit.errors.commitFailed', { details: String(error) }))
    } finally {
      setIsCommitting(false)
      setConfirmAmendOpen(false)
      commitInFlight.current = false
    }
  }

  const handleCommit = () => {
    if (!canCommit || commitInFlight.current || generationInFlight.current) return
    // Amending a commit that already matches the upstream rewrites published
    // history; gate it behind a confirmation.
    if (amend && commitContext?.hasUpstream && commitContext.ahead === 0) {
      setConfirmAmendOpen(true)
      return
    }
    void runCommit()
  }

  const handlePush = async () => {
    if (isPushing || isCommitting || generationInFlight.current) return
    setIsPushing(true)
    try {
      await push(cwd)
      toast.success(t('push.toasts.success'))
    } catch (error) {
      toast.error(t('push.errors.failed', { details: String(error) }))
    } finally {
      setIsPushing(false)
    }
  }

  const handleSwitchBranch = useCallback(
    async (name: string) => {
      if (generationInFlight.current) return
      const hasChanges = hasUncommittedChanges
      if (hasChanges) {
        setPendingBranchName(name)
        setConfirmBranchSwitchOpen(true)
        return
      }

      setIsMutating(true)
      try {
        await branchSwitch(cwd, name)
        toast.success(t('branch.toasts.switched', { branch: name }))
      } catch (error) {
        toast.error(t('branch.errors.switchFailed', { details: String(error) }))
      } finally {
        setIsMutating(false)
      }
    },
    [cwd, branchSwitch, hasUncommittedChanges, t]
  )

  const handleExecuteSwitchBranch = useCallback(
    async (strategy: 'bring' | 'stash') => {
      if (generationInFlight.current) return
      const name = pendingBranchName
      if (!name) return
      setConfirmBranchSwitchOpen(false)
      setIsMutating(true)

      try {
        if (strategy === 'stash') {
          await stashSave(cwd, `Auto-stash before checkout to ${name}`, true)
          await branchSwitch(cwd, name)
          try {
            await stashPop(cwd, 0)
            toast.success(t('branch.toasts.switchedReapplied', { branch: name }))
          } catch (popErr) {
            console.error('Auto-stash pop failed:', popErr)
            toast.warning(t('branch.toasts.stashConflict', { branch: name }))
          }
        } else {
          await branchSwitch(cwd, name)
          toast.success(t('branch.toasts.switchedCarried', { branch: name }))
        }
      } catch (error) {
        toast.error(t('branch.errors.switchFailed', { details: String(error) }))
      } finally {
        setIsMutating(false)
        setPendingBranchName('')
      }
    },
    [cwd, pendingBranchName, branchSwitch, stashSave, stashPop, t]
  )

  const handleCreateBranch = useCallback(async () => {
    if (generationInFlight.current) return
    const name = branchNameInput.trim()
    if (!name) return
    setIsMutating(true)
    try {
      await branchCreate(cwd, name)
      toast.success(t('branch.toasts.created', { branch: name }))
      setIsCreateBranchOpen(false)
      setBranchNameInput('')
    } catch (error) {
      toast.error(t('branch.errors.createFailed', { details: String(error) }))
    } finally {
      setIsMutating(false)
    }
  }, [cwd, branchNameInput, branchCreate, t])

  const handleStashSave = useCallback(async () => {
    if (generationInFlight.current) return
    const msg = stashMessage.trim() || undefined
    setIsMutating(true)
    try {
      await stashSave(cwd, msg, stashIncludeUntracked)
      toast.success(t('stash.toasts.saved'))
      setIsStashOpen(false)
      setStashMessage('')
      setStashIncludeUntracked(false)
    } catch (error) {
      toast.error(t('stash.errors.saveFailed', { details: String(error) }))
    } finally {
      setIsMutating(false)
    }
  }, [cwd, stashMessage, stashIncludeUntracked, stashSave, t])

  const handleApplyStash = useCallback(
    async (index: number) => {
      if (generationInFlight.current) return
      setIsMutating(true)
      try {
        await stashApply(cwd, index)
        toast.success(t('stash.toasts.applied', { index }))
      } catch (error) {
        toast.error(t('stash.errors.applyFailed', { details: String(error) }))
      } finally {
        setIsMutating(false)
      }
    },
    [cwd, stashApply, t]
  )

  const handlePopStash = useCallback(
    async (index: number) => {
      if (generationInFlight.current) return
      setIsMutating(true)
      try {
        await stashPop(cwd, index)
        toast.success(t('stash.toasts.popped', { index }))
      } catch (error) {
        toast.error(t('stash.errors.popFailed', { details: String(error) }))
      } finally {
        setIsMutating(false)
      }
    },
    [cwd, stashPop, t]
  )

  const handleDropStash = useCallback(
    async (index: number) => {
      if (generationInFlight.current) return
      setIsMutating(true)
      try {
        await stashDrop(cwd, index)
        toast.success(t('stash.toasts.dropped', { index }))
      } catch (error) {
        toast.error(t('stash.errors.dropFailed', { details: String(error) }))
      } finally {
        setIsMutating(false)
      }
    },
    [cwd, stashDrop, t]
  )

  const onBranch = !!commitContext?.branch
  const ahead = commitContext?.ahead ?? 0
  const behind = commitContext?.behind ?? 0
  // Once an upstream exists, there is nothing to push when we are not ahead.
  // Before an upstream exists, publishing is always meaningful.
  const hasSomethingToPush = !commitContext?.hasUpstream || ahead > 0
  const canPush = onBranch && hasSomethingToPush && !isPushing && !isCommitting && !isGenerating
  const pushLabel = !commitContext?.hasUpstream
    ? t('push.publish')
    : ahead > 0
      ? t('push.count', { count: ahead, formattedCount: formatNumber(ahead) })
      : t('push.upToDate')

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
            <div className="border-b border-border bg-background p-3 flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                aria-label={t('diff.backToFiles')}
                onClick={() => setSelectedFile(null)}
              >
                <ChevronLeft size={16} />
              </Button>
              <div className="flex items-center gap-3 overflow-hidden min-w-0">
                <FileCode size={16} className="text-primary shrink-0" />
                <span className="text-sm font-medium truncate">{selectedFile}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <div
                  className="flex items-center rounded-md border border-border p-0.5"
                  role="group"
                  aria-label={t('diff.viewMode')}
                >
                  <Button
                    type="button"
                    variant={diffViewMode === 'inline' ? 'secondary' : 'ghost'}
                    size="icon"
                    className="h-7 w-7"
                    title={t('diff.inline')}
                    aria-label={t('diff.inline')}
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
                    title={t('diff.sideBySide')}
                    aria-label={t('diff.sideBySide')}
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
                  {selectedStaged ? t('diff.staged') : t('diff.workingTree')}
                </span>
              </div>
            </div>
            <ScrollArea className="flex-1 font-mono text-xs">
              {currentDiff === undefined || currentDiff === null ? (
                <div className="h-full flex items-center justify-center text-muted-foreground">
                  <RefreshCw className="animate-spin mr-2" size={16} />
                  {t('diff.loading')}
                </div>
              ) : currentDiff.trim().length > 0 ? (
                <GitDiffView
                  diff={currentDiff}
                  mode={diffViewMode}
                  filePath={selectedFile ?? undefined}
                />
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-8 text-center">
                  <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center mb-3 text-muted-foreground/60">
                    <FileText size={18} />
                  </div>
                  <h3 className="text-sm font-medium text-foreground mb-1">
                    {t('diff.noAvailable')}
                  </h3>
                  <p className="text-xs max-w-[260px]">{t('diff.unavailableDescription')}</p>
                </div>
              )}
            </ScrollArea>
          </div>
        ) : (
          <div className="flex w-full flex-col shrink-0">
            <div className="p-3 border-b border-border flex flex-col gap-2 bg-muted/20">
              <div className="flex items-center justify-between">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2 font-medium text-xs flex items-center gap-1.5 max-w-[190px] truncate hover:bg-secondary"
                    >
                      <GitBranch size={13} className="text-muted-foreground shrink-0" />
                      <span className="truncate">
                        {commitContext?.branch ?? t('branch.detachedHead')}
                      </span>
                      <ChevronDown
                        size={12}
                        className="text-muted-foreground opacity-50 shrink-0"
                      />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    className="w-56 max-h-[300px] overflow-y-auto z-50"
                  >
                    <DropdownMenuItem
                      onClick={() => setIsCreateBranchOpen(true)}
                      className="flex items-center gap-2 text-xs cursor-pointer"
                    >
                      <Plus size={12} />
                      {t('branch.createNew')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {branches.length === 0 ? (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">
                        {t('branch.noneFound')}
                      </div>
                    ) : (
                      branches.map((b) => (
                        <DropdownMenuItem
                          key={b}
                          onClick={() => handleSwitchBranch(b)}
                          className={cn(
                            'flex items-center justify-between text-xs cursor-pointer',
                            b === commitContext?.branch && 'bg-accent font-semibold'
                          )}
                        >
                          <span className="truncate">{b}</span>
                          {b === commitContext?.branch && (
                            <Check size={12} className="text-primary" />
                          )}
                        </DropdownMenuItem>
                      ))
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>

                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-secondary"
                  title={t('stash.action')}
                  aria-label={t('stash.action')}
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
                  placeholder={t('changes.filterPlaceholder')}
                  aria-label={t('changes.filterLabel')}
                  className="w-full bg-secondary/50 border-none rounded-md py-1.5 pl-8 pr-3 text-xs focus:ring-1 focus:ring-primary outline-none"
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
                      label={t('changes.staged')}
                      count={stagedFiles.length}
                      selectionCount={stagedSelectionCount}
                    >
                      <SectionAction
                        icon={<Minus size={13} />}
                        label={t('changes.unstageAll')}
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
                          isActive={selectedFile === file.path && selectedStaged}
                          isSelected={inSelection}
                          onClick={(e) => handleFileClick(e, file.path, true, stagedFiles)}
                        >
                          <RowAction
                            icon={<Minus size={13} />}
                            label={t('changes.unstage')}
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
                    label={t('changes.title')}
                    count={unstagedFiles.length}
                    selectionCount={unstagedSelectionCount}
                  >
                    {unstagedFiles.length > 0 && (
                      <>
                        <SectionAction
                          icon={<RotateCcw size={13} />}
                          label={t('changes.discardAll')}
                          variant="danger"
                          disabled={isMutating || isGenerating}
                          onClick={() => requestDiscard(unstagedFiles.map((f) => f.path))}
                        />
                        <SectionAction
                          icon={<Plus size={13} />}
                          label={t('changes.stageAll')}
                          disabled={isMutating || isGenerating}
                          onClick={() => runStage(unstagedFiles.map((f) => f.path))}
                        />
                      </>
                    )}
                  </SectionHeader>
                  {unstagedFiles.length === 0 ? (
                    <div className="px-4 py-8 text-center">
                      <p className="text-xs text-muted-foreground">{t('changes.none')}</p>
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
                            label={t('changes.discard')}
                            variant="danger"
                            disabled={isMutating || isGenerating}
                            onClick={() => requestDiscard(targetsFor(file.path, 'unstaged'))}
                          />
                          <RowAction
                            icon={<Plus size={13} />}
                            label={t('changes.stage')}
                            disabled={isMutating || isGenerating}
                            onClick={() => runStage(targetsFor(file.path, 'unstaged'))}
                          />
                        </FileItem>
                      )
                    })
                  )}
                </div>

                {stashes.length > 0 && (
                  <div className="space-y-1 pt-2 border-t border-border/30 w-full min-w-0">
                    <SectionHeader
                      label={t('stash.title')}
                      count={stashes.length}
                      selectionCount={0}
                    />
                    <div className="space-y-0.5 w-full min-w-0">
                      {stashes.map((s) => (
                        <div
                          key={s.index}
                          className="group flex w-full min-w-0 items-center justify-between px-2 py-1.5 rounded hover:bg-secondary/40 text-xs text-foreground cursor-default transition-all"
                        >
                          <div className="flex flex-col min-w-0 flex-1 pr-1.5">
                            <span className="font-semibold text-muted-foreground text-3xs">{`stash@{${s.index}}`}</span>
                            <span
                              className="truncate text-muted-foreground text-2xs leading-tight"
                              title={s.message}
                            >
                              {s.message || t('stash.noMessage')}
                            </span>
                          </div>
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                            <button
                              type="button"
                              title={t('stash.apply')}
                              aria-label={t('stash.apply')}
                              onClick={() => handleApplyStash(s.index)}
                              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
                            >
                              <ClipboardPaste size={11} />
                            </button>
                            <button
                              type="button"
                              title={t('stash.pop')}
                              aria-label={t('stash.pop')}
                              onClick={() => handlePopStash(s.index)}
                              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
                            >
                              <ArchiveRestore size={11} />
                            </button>
                            <button
                              type="button"
                              title={t('stash.drop')}
                              aria-label={t('stash.drop')}
                              onClick={() => handleDropStash(s.index)}
                              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-red-500/10 hover:text-red-400"
                            >
                              <Trash2 size={11} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </ScrollArea>

            {/* Commit footer (GitHub Desktop style) */}
            <div className="border-t border-border p-3 space-y-2 bg-background/60">
              <input
                type="text"
                aria-label={t('commit.summaryLabel')}
                placeholder={amend ? t('commit.updateMessage') : t('commit.summaryRequired')}
                className="w-full bg-secondary/50 border-none rounded-md py-1.5 px-3 text-xs focus:ring-1 focus:ring-primary outline-none"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                disabled={isCommitting || isGenerating}
              />
              <textarea
                aria-label={t('commit.descriptionLabel')}
                placeholder={t('commit.descriptionOptional')}
                rows={3}
                className="w-full resize-none bg-secondary/50 border-none rounded-md py-1.5 px-3 text-xs focus:ring-1 focus:ring-primary outline-none"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={isCommitting || isGenerating}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full h-8 text-xs gap-2"
                onClick={() => void handleGenerateMessage()}
                disabled={!canGenerate}
                title={
                  stagedCount === 0
                    ? t('commit.generateNeedsStage')
                    : !hasUsableAgent
                      ? t('commit.generateNeedsAgent')
                      : t('commit.generateTitle')
                }
              >
                <Sparkles size={14} className={cn(isGenerating && 'animate-pulse')} />
                {isGenerating ? t('commit.generating') : t('commit.generate')}
              </Button>
              <label
                className={cn(
                  'flex items-center gap-2 text-2xs select-none',
                  commitContext?.hasHead
                    ? 'text-muted-foreground cursor-pointer'
                    : 'text-muted-foreground/40 cursor-not-allowed'
                )}
                title={
                  commitContext?.hasHead
                    ? t('commit.amendDescription')
                    : t('commit.noCommitToAmend')
                }
              >
                <input
                  type="checkbox"
                  className="h-3 w-3 accent-primary"
                  checked={amend}
                  onChange={handleToggleAmend}
                  disabled={!commitContext?.hasHead || isCommitting || isGenerating}
                />
                {t('commit.amendLast')}
              </label>
              <Button
                variant="default"
                size="sm"
                className="w-full h-8 text-xs gap-2"
                onClick={handleCommit}
                disabled={!canCommit}
                title={
                  amend
                    ? t('commit.amendTitle')
                    : stagedCount === 0
                      ? t('commit.stageToCommit')
                      : t('commit.commitStaged')
                }
              >
                <GitCommit size={14} />
                {isCommitting
                  ? t('commit.committing')
                  : amend
                    ? t('commit.amend')
                    : commitContext?.branch
                      ? t('commit.toBranch', { branch: commitContext.branch })
                      : t('commit.action')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="w-full h-8 text-xs gap-2"
                onClick={handlePush}
                disabled={!canPush}
                title={
                  !onBranch
                    ? t('push.detached')
                    : !commitContext?.hasUpstream
                      ? t('push.publishTitle')
                      : ahead > 0
                        ? t('push.pushTitle')
                        : t('push.nothingToPush')
                }
              >
                <ArrowUp size={14} className={cn(isPushing && 'animate-pulse')} />
                {isPushing ? t('push.pushing') : pushLabel}
                {behind > 0 && <span className="text-3xs text-amber-500">↓{behind}</span>}
              </Button>
            </div>
          </div>
        )}

        <ConfirmDialog
          isOpen={confirmDiscardOpen}
          variant="danger"
          title={t('discard.title')}
          message={
            discardTargets.length > 1
              ? t('discard.multiple', {
                  count: discardTargets.length,
                  formattedCount: formatNumber(discardTargets.length)
                })
              : discardTargets[0]
                ? t('discard.single', { path: discardTargets[0] })
                : ''
          }
          confirmLabel={t('discard.confirm')}
          isLoading={isMutating}
          onConfirm={confirmDiscard}
          onCancel={() => {
            setConfirmDiscardOpen(false)
            setDiscardTargets([])
          }}
        />

        <ConfirmDialog
          isOpen={confirmAmendOpen}
          variant="danger"
          title={t('commit.amendPushedTitle')}
          message={t('commit.amendPushedMessage')}
          confirmLabel={t('commit.amendAnyway')}
          isLoading={isCommitting}
          onConfirm={runCommit}
          onCancel={() => setConfirmAmendOpen(false)}
        />

        <Dialog open={isCreateBranchOpen} onOpenChange={setIsCreateBranchOpen}>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>{t('branch.createTitle')}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-2 text-xs">
              <div className="space-y-1">
                <label className="text-muted-foreground">{t('branch.nameLabel')}</label>
                <input
                  type="text"
                  className="w-full bg-secondary/50 border-none rounded-md py-1.5 px-3 focus:ring-1 focus:ring-primary outline-none text-xs"
                  placeholder={t('branch.namePlaceholder')}
                  value={branchNameInput}
                  onChange={(e) => setBranchNameInput(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setIsCreateBranchOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={handleCreateBranch}
                disabled={!branchNameInput.trim() || isMutating || isGenerating}
              >
                {t('branch.createAndSwitch')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={isStashOpen} onOpenChange={setIsStashOpen}>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>{t('stash.dialogTitle')}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-2 text-xs">
              <div className="space-y-1">
                <label className="text-muted-foreground">{t('stash.messageOptional')}</label>
                <input
                  type="text"
                  className="w-full bg-secondary/50 border-none rounded-md py-1.5 px-3 focus:ring-1 focus:ring-primary outline-none text-xs"
                  placeholder={t('stash.placeholder')}
                  value={stashMessage}
                  onChange={(e) => setStashMessage(e.target.value)}
                />
              </div>
              <label className="flex items-center gap-2 cursor-pointer select-none text-2xs">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-primary"
                  checked={stashIncludeUntracked}
                  onChange={(e) => setStashIncludeUntracked(e.target.checked)}
                />
                {t('stash.includeUntracked')}
              </label>
            </div>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setIsStashOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={handleStashSave}
                disabled={isMutating || isGenerating}
              >
                {t('stash.action')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={confirmBranchSwitchOpen} onOpenChange={setConfirmBranchSwitchOpen}>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>{t('branch.uncommittedTitle')}</DialogTitle>
            </DialogHeader>
            <div className="py-2 text-xs text-muted-foreground space-y-2">
              <p>{t('branch.uncommittedMessage', { branch: pendingBranchName })}</p>
              <ul className="list-disc pl-4 space-y-1">
                <li>{t('branch.bringDescription')}</li>
                <li>{t('branch.stashDescription')}</li>
              </ul>
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="ghost" size="sm" onClick={() => setConfirmBranchSwitchOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleExecuteSwitchBranch('bring')}
                disabled={isMutating || isGenerating}
              >
                {t('branch.bringChanges')}
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={() => handleExecuteSwitchBranch('stash')}
                disabled={isMutating || isGenerating}
              >
                {t('branch.stashAndSwitch')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full bg-background overflow-hidden">
      {/* File List Sidebar */}
      <div className="w-80 border-r border-border flex flex-col shrink-0">
        <div className="p-3 border-b border-border flex flex-col gap-2 bg-muted/20">
          <div className="flex items-center justify-between">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 font-medium text-xs flex items-center gap-1.5 max-w-[190px] truncate hover:bg-secondary"
                >
                  <GitBranch size={13} className="text-muted-foreground shrink-0" />
                  <span className="truncate">
                    {commitContext?.branch ?? t('branch.detachedHead')}
                  </span>
                  <ChevronDown size={12} className="text-muted-foreground opacity-50 shrink-0" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-56 max-h-[300px] overflow-y-auto z-50"
              >
                <DropdownMenuItem
                  onClick={() => setIsCreateBranchOpen(true)}
                  className="flex items-center gap-2 text-xs cursor-pointer"
                >
                  <Plus size={12} />
                  {t('branch.createNew')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {branches.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    {t('branch.noneFound')}
                  </div>
                ) : (
                  branches.map((b) => (
                    <DropdownMenuItem
                      key={b}
                      onClick={() => handleSwitchBranch(b)}
                      className={cn(
                        'flex items-center justify-between text-xs cursor-pointer',
                        b === commitContext?.branch && 'bg-accent font-semibold'
                      )}
                    >
                      <span className="truncate">{b}</span>
                      {b === commitContext?.branch && <Check size={12} className="text-primary" />}
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-secondary"
              title={t('stash.action')}
              aria-label={t('stash.action')}
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
              placeholder={t('changes.filterPlaceholder')}
              aria-label={t('changes.filterLabel')}
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
                  label={t('changes.staged')}
                  count={stagedFiles.length}
                  selectionCount={stagedSelectionCount}
                >
                  <SectionAction
                    icon={<Minus size={13} />}
                    label={t('changes.unstageAll')}
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
                        label={t('changes.unstage')}
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
                label={t('changes.title')}
                count={unstagedFiles.length}
                selectionCount={unstagedSelectionCount}
              >
                {unstagedFiles.length > 0 && (
                  <>
                    <SectionAction
                      icon={<RotateCcw size={13} />}
                      label={t('changes.discardAll')}
                      variant="danger"
                      disabled={isMutating || isGenerating}
                      onClick={() => requestDiscard(unstagedFiles.map((f) => f.path))}
                    />
                    <SectionAction
                      icon={<Plus size={13} />}
                      label={t('changes.stageAll')}
                      disabled={isMutating || isGenerating}
                      onClick={() => runStage(unstagedFiles.map((f) => f.path))}
                    />
                  </>
                )}
              </SectionHeader>
              {unstagedFiles.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-xs text-muted-foreground">{t('changes.none')}</p>
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
                        label={t('changes.discard')}
                        variant="danger"
                        disabled={isMutating || isGenerating}
                        onClick={() => requestDiscard(targetsFor(file.path, 'unstaged'))}
                      />
                      <RowAction
                        icon={<Plus size={13} />}
                        label={t('changes.stage')}
                        disabled={isMutating || isGenerating}
                        onClick={() => runStage(targetsFor(file.path, 'unstaged'))}
                      />
                    </FileItem>
                  )
                })
              )}
            </div>

            {stashes.length > 0 && (
              <div className="space-y-1 pt-2 border-t border-border/30 w-full min-w-0">
                <SectionHeader label={t('stash.title')} count={stashes.length} selectionCount={0} />
                <div className="space-y-0.5 w-full min-w-0">
                  {stashes.map((s) => (
                    <div
                      key={s.index}
                      className="group flex w-full min-w-0 items-center justify-between px-2 py-1.5 rounded hover:bg-secondary/40 text-xs text-foreground cursor-default transition-all"
                    >
                      <div className="flex flex-col min-w-0 flex-1 pr-1.5">
                        <span className="font-semibold text-muted-foreground text-3xs">{`stash@{${s.index}}`}</span>
                        <span
                          className="truncate text-muted-foreground text-2xs leading-tight"
                          title={s.message}
                        >
                          {s.message || t('stash.noMessage')}
                        </span>
                      </div>
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        <button
                          type="button"
                          title={t('stash.apply')}
                          aria-label={t('stash.apply')}
                          onClick={() => handleApplyStash(s.index)}
                          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
                        >
                          <ClipboardPaste size={11} />
                        </button>
                        <button
                          type="button"
                          title={t('stash.pop')}
                          aria-label={t('stash.pop')}
                          onClick={() => handlePopStash(s.index)}
                          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
                        >
                          <ArchiveRestore size={11} />
                        </button>
                        <button
                          type="button"
                          title={t('stash.drop')}
                          aria-label={t('stash.drop')}
                          onClick={() => handleDropStash(s.index)}
                          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-red-500/10 hover:text-red-400"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Commit footer (GitHub Desktop style) */}
        <div className="border-t border-border p-3 space-y-2 bg-background/60">
          <input
            type="text"
            aria-label={t('commit.summaryLabel')}
            placeholder={amend ? t('commit.updateMessage') : t('commit.summaryRequired')}
            className="w-full bg-secondary/50 border-none rounded-md py-1.5 px-3 text-xs focus:ring-1 focus:ring-primary outline-none"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            disabled={isCommitting || isGenerating}
          />
          <textarea
            aria-label={t('commit.descriptionLabel')}
            placeholder={t('commit.descriptionOptional')}
            rows={3}
            className="w-full resize-none bg-secondary/50 border-none rounded-md py-1.5 px-3 text-xs focus:ring-1 focus:ring-primary outline-none"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={isCommitting || isGenerating}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full h-8 text-xs gap-2"
            onClick={() => void handleGenerateMessage()}
            disabled={!canGenerate}
            title={
              stagedCount === 0
                ? t('commit.generateNeedsStage')
                : !hasUsableAgent
                  ? t('commit.generateNeedsAgent')
                  : t('commit.generateTitle')
            }
          >
            <Sparkles size={14} className={cn(isGenerating && 'animate-pulse')} />
            {isGenerating ? t('commit.generating') : t('commit.generate')}
          </Button>
          <label
            className={cn(
              'flex items-center gap-2 text-2xs select-none',
              commitContext?.hasHead
                ? 'text-muted-foreground cursor-pointer'
                : 'text-muted-foreground/40 cursor-not-allowed'
            )}
            title={
              commitContext?.hasHead ? t('commit.amendDescription') : t('commit.noCommitToAmend')
            }
          >
            <input
              type="checkbox"
              className="h-3 w-3 accent-primary"
              checked={amend}
              onChange={handleToggleAmend}
              disabled={!commitContext?.hasHead || isCommitting || isGenerating}
            />
            {t('commit.amendLast')}
          </label>
          <Button
            variant="default"
            size="sm"
            className="w-full h-8 text-xs gap-2"
            onClick={handleCommit}
            disabled={!canCommit}
            title={
              amend
                ? t('commit.amendTitle')
                : stagedCount === 0
                  ? t('commit.stageToCommit')
                  : t('commit.commitStaged')
            }
          >
            <GitCommit size={14} />
            {isCommitting
              ? t('commit.committing')
              : amend
                ? t('commit.amend')
                : commitContext?.branch
                  ? t('commit.toBranch', { branch: commitContext.branch })
                  : t('commit.action')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full h-8 text-xs gap-2"
            onClick={handlePush}
            disabled={!canPush}
            title={
              !onBranch
                ? t('push.detached')
                : !commitContext?.hasUpstream
                  ? t('push.publishTitle')
                  : ahead > 0
                    ? t('push.pushTitle')
                    : t('push.nothingToPush')
            }
          >
            <ArrowUp size={14} className={cn(isPushing && 'animate-pulse')} />
            {isPushing ? t('push.pushing') : pushLabel}
            {behind > 0 && <span className="text-3xs text-amber-500">↓{behind}</span>}
          </Button>
        </div>
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
                  aria-label={t('diff.viewMode')}
                >
                  <Button
                    type="button"
                    variant={diffViewMode === 'inline' ? 'secondary' : 'ghost'}
                    size="icon"
                    className="h-7 w-7"
                    title={t('diff.inline')}
                    aria-label={t('diff.inline')}
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
                    title={t('diff.sideBySide')}
                    aria-label={t('diff.sideBySide')}
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
                  {selectedStaged ? t('diff.staged') : t('diff.workingTree')}
                </span>
              </div>
            </div>
            <ScrollArea className="flex-1 font-mono text-xs">
              {currentDiff === undefined || currentDiff === null ? (
                <div className="h-full flex items-center justify-center text-muted-foreground">
                  <RefreshCw className="animate-spin mr-2" size={16} />
                  {t('diff.loading')}
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
                  <h3 className="text-sm font-medium text-foreground mb-1">
                    {t('diff.noAvailable')}
                  </h3>
                  <p className="text-xs max-w-[260px]">{t('diff.unavailableDescription')}</p>
                </div>
              )}
            </ScrollArea>
          </>
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-8 text-center">
            <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center mb-4 text-muted-foreground/50">
              <GitBranch size={24} />
            </div>
            <h3 className="text-sm font-medium text-foreground mb-1">{t('diff.selectFile')}</h3>
            <p className="text-xs max-w-[240px]">{t('diff.selectFileDescription')}</p>
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={confirmDiscardOpen}
        variant="danger"
        title={t('discard.title')}
        message={
          discardTargets.length > 1
            ? t('discard.multiple', {
                count: discardTargets.length,
                formattedCount: formatNumber(discardTargets.length)
              })
            : discardTargets[0]
              ? t('discard.single', { path: discardTargets[0] })
              : ''
        }
        confirmLabel={t('discard.confirm')}
        isLoading={isMutating}
        onConfirm={confirmDiscard}
        onCancel={() => {
          setConfirmDiscardOpen(false)
          setDiscardTargets([])
        }}
      />

      <ConfirmDialog
        isOpen={confirmAmendOpen}
        variant="danger"
        title={t('commit.amendPushedTitle')}
        message={t('commit.amendPushedMessage')}
        confirmLabel={t('commit.amendAnyway')}
        isLoading={isCommitting}
        onConfirm={runCommit}
        onCancel={() => setConfirmAmendOpen(false)}
      />

      <Dialog open={isCreateBranchOpen} onOpenChange={setIsCreateBranchOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{t('branch.createTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2 text-xs">
            <div className="space-y-1">
              <label className="text-muted-foreground">{t('branch.nameLabel')}</label>
              <input
                type="text"
                className="w-full bg-secondary/50 border-none rounded-md py-1.5 px-3 focus:ring-1 focus:ring-primary outline-none text-xs"
                placeholder={t('branch.namePlaceholder')}
                value={branchNameInput}
                onChange={(e) => setBranchNameInput(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setIsCreateBranchOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={handleCreateBranch}
              disabled={!branchNameInput.trim() || isMutating || isGenerating}
            >
              {t('branch.createAndSwitch')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isStashOpen} onOpenChange={setIsStashOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{t('stash.dialogTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2 text-xs">
            <div className="space-y-1">
              <label className="text-muted-foreground">{t('stash.messageOptional')}</label>
              <input
                type="text"
                className="w-full bg-secondary/50 border-none rounded-md py-1.5 px-3 focus:ring-1 focus:ring-primary outline-none text-xs"
                placeholder={t('stash.placeholder')}
                value={stashMessage}
                onChange={(e) => setStashMessage(e.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 cursor-pointer select-none text-2xs">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-primary"
                checked={stashIncludeUntracked}
                onChange={(e) => setStashIncludeUntracked(e.target.checked)}
              />
              {t('stash.includeUntracked')}
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setIsStashOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={handleStashSave}
              disabled={isMutating || isGenerating}
            >
              {t('stash.action')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmBranchSwitchOpen} onOpenChange={setConfirmBranchSwitchOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{t('branch.uncommittedTitle')}</DialogTitle>
          </DialogHeader>
          <div className="py-2 text-xs text-muted-foreground space-y-2">
            <p>{t('branch.uncommittedMessage', { branch: pendingBranchName })}</p>
            <ul className="list-disc pl-4 space-y-1">
              <li>{t('branch.bringDescription')}</li>
              <li>{t('branch.stashDescription')}</li>
            </ul>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="ghost" size="sm" onClick={() => setConfirmBranchSwitchOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleExecuteSwitchBranch('bring')}
              disabled={isMutating || isGenerating}
            >
              {t('branch.bringChanges')}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => handleExecuteSwitchBranch('stash')}
              disabled={isMutating || isGenerating}
            >
              {t('branch.stashAndSwitch')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function SectionHeader({
  label,
  count,
  selectionCount,
  children
}: {
  label: string
  count: number
  selectionCount: number
  children?: React.ReactNode
}) {
  const { t } = useTranslation('git')

  return (
    <div className="group/section flex items-center justify-between px-2 py-1">
      <div className="label-group text-muted-foreground flex items-center gap-2">
        <ChevronDown size={12} />
        {label} ({formatNumber(count)})
        {selectionCount > 1 && (
          <span className="text-primary normal-case font-medium">
            ·{' '}
            {t('changes.selectedCount', {
              count: selectionCount,
              formattedCount: formatNumber(selectionCount)
            })}
          </span>
        )}
      </div>
      <div className="flex items-center gap-0.5 opacity-60 group-hover/section:opacity-100 focus-within:opacity-100 transition-opacity">
        {children}
      </div>
    </div>
  )
}

function SectionAction({
  icon,
  label,
  onClick,
  disabled,
  variant
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  variant?: 'danger'
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
        variant === 'danger'
          ? 'text-muted-foreground hover:bg-red-500/10 hover:text-red-400'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
      )}
    >
      {icon}
    </button>
  )
}

function RowAction({
  icon,
  label,
  onClick,
  disabled,
  variant
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  variant?: 'danger'
}) {
  // Stop the click from bubbling to the row, which would otherwise change the
  // selection / diff target instead of running the action.
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onClick()
  }
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={handleClick}
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
        variant === 'danger'
          ? 'text-muted-foreground hover:bg-red-500/10 hover:text-red-400'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
      )}
    >
      {icon}
    </button>
  )
}

const GIT_STATUS_LABEL_KEYS = {
  added: 'status.added',
  modified: 'status.modified',
  deleted: 'status.deleted',
  renamed: 'status.renamed',
  untracked: 'status.untracked',
  staged: 'status.staged'
} as const satisfies Record<GitFileStatus, string>

function GitStatusBadge({ status }: { status: GitFileStatus }) {
  const { t } = useTranslation('git')
  const label = t(GIT_STATUS_LABEL_KEYS[status])
  let icon: React.ReactNode
  switch (status) {
    case 'added':
      icon = <Plus className="text-green-500" size={14} aria-hidden />
      break
    case 'modified':
      icon = <Pencil className="text-amber-500" size={14} aria-hidden />
      break
    case 'deleted':
      icon = <Minus className="text-red-500" size={14} aria-hidden />
      break
    case 'renamed':
      icon = <RotateCcw className="text-blue-500" size={14} aria-hidden />
      break
    case 'untracked':
      icon = <FileQuestion className="text-orange-500" size={14} aria-hidden />
      break
    case 'staged':
      icon = <Check className="text-primary" size={14} aria-hidden />
      break
    default:
      icon = <FileCode size={14} aria-hidden />
  }

  return (
    <div
      className="flex h-5 w-5 shrink-0 items-center justify-center"
      title={label}
      aria-label={label}
    >
      {icon}
    </div>
  )
}

function FileItem({
  file,
  isActive,
  isSelected,
  onClick,
  children
}: {
  file: { path: string; status: GitFileStatus }
  isActive: boolean
  isSelected: boolean
  onClick: (e: React.MouseEvent | React.KeyboardEvent) => void
  children?: React.ReactNode
}) {
  const fileName = file.path.split('/').pop() || file.path
  const dirName = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : ''

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.currentTarget !== e.target) {
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClick(e)
    }
  }

  return (
    <div
      role="option"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      aria-selected={isSelected || isActive}
      className={cn(
        'group/row flex w-full items-center gap-3 px-3 py-2 rounded-md text-left cursor-pointer transition-colors select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
        isSelected
          ? 'bg-primary/15 text-foreground'
          : isActive
            ? 'bg-primary/10 text-primary'
            : 'hover:bg-secondary/80 text-muted-foreground hover:text-foreground'
      )}
    >
      <GitStatusBadge status={file.status} />
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <span className="text-2xs font-medium truncate leading-tight">{fileName}</span>
        {dirName && <span className="text-4xs truncate opacity-50 leading-tight">{dirName}</span>}
      </div>
      <div
        className={cn(
          'flex shrink-0 items-center gap-0.5 transition-opacity focus-within:opacity-100',
          isSelected || isActive ? 'opacity-100' : 'opacity-60 group-hover/row:opacity-100'
        )}
      >
        {children}
      </div>
    </div>
  )
}
