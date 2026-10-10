import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { gitApi } from '@/lib/git-api'
import { logFrontendError } from '@/lib/log-api'
import { useAcpStore } from '@/stores/acp-store'
import { useGitStatusStore } from '@/stores/git-status-store'

const MAX_COMMIT_MESSAGE_DIFF_CHARS = 120_000

interface UseGitActionsOptions {
  cwd: string
  /** Syncs which side (staged vs unstaged) of the selected path is shown in the
      diff view — a row-level stage/unstage flips it so the diff follows. */
  setSelectedStaged: (staged: boolean) => void
  /** Clears the multi-selection (paths + section + anchor) owned by GitPanel. */
  clearSelection: () => void
}

/**
 * Git mutation actions for GitPanel: stage/unstage/discard, per-hunk apply,
 * commit + AI message generation, push, stash and branch operations. Owns all
 * of the panel's mutation state (busy flags, dialog targets, commit composer
 * fields) and the synchronous in-flight refs that guard double-dispatch.
 */
export function useGitActions({ cwd, setSelectedStaged, clearSelection }: UseGitActionsOptions) {
  const statuses = useGitStatusStore((state) => state.statuses)
  const selectedFile = useGitStatusStore((state) => state.selectedFile)
  const setSelectedFile = useGitStatusStore((state) => state.setSelectedFile)
  const fetchDiff = useGitStatusStore((state) => state.fetchDiff)
  const stageFiles = useGitStatusStore((state) => state.stageFiles)
  const unstageFiles = useGitStatusStore((state) => state.unstageFiles)
  const discardFiles = useGitStatusStore((state) => state.discardFiles)
  const stageHunk = useGitStatusStore((state) => state.stageHunk)
  const unstageHunk = useGitStatusStore((state) => state.unstageHunk)
  const commitContexts = useGitStatusStore((state) => state.commitContexts)
  const commit = useGitStatusStore((state) => state.commit)
  const push = useGitStatusStore((state) => state.push)
  const stashSave = useGitStatusStore((state) => state.stashSave)
  const stashApply = useGitStatusStore((state) => state.stashApply)
  const stashPop = useGitStatusStore((state) => state.stashPop)
  const stashDrop = useGitStatusStore((state) => state.stashDrop)
  const branchSwitch = useGitStatusStore((state) => state.branchSwitch)
  const branchCreate = useGitStatusStore((state) => state.branchCreate)
  const selectedAgentConfigId = useAcpStore((state) => state.selectedAgentConfigId)
  const agentConfigs = useAcpStore((state) => state.agentConfigs)
  const generateCommitMessage = useAcpStore((state) => state.generateCommitMessage)

  const commitContext = commitContexts[cwd] ?? null

  const [isMutating, setIsMutating] = useState(false)

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
  // Synchronous in-flight guard so a same-tick double-click cannot dispatch two
  // commits before the isCommitting state has re-rendered.
  const commitInFlight = useRef(false)
  const generationInFlight = useRef(false)
  // Synchronous guard for per-hunk stage/unstage: a fast second click on
  // another hunk would otherwise build a patch from the pre-mutation diff
  // and apply it at a shifted offset once `--recount` relaxes the header.
  const hunkInFlight = useRef(false)
  const generationToken = useRef(0)
  const currentCwd = useRef(cwd)
  const currentStatuses = useRef(statuses)

  useEffect(() => {
    currentCwd.current = cwd
    currentStatuses.current = statuses
  }, [cwd, statuses])

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
    clearSelection()
  }, [cwd, setSelectedFile, setSelectedStaged, clearSelection])

  const allStatuses = statuses[cwd] ?? []
  const hasUncommittedChanges = allStatuses.length > 0

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
        toast.error(`Failed to stage: ${String(error)}`)
      } finally {
        setIsMutating(false)
      }
    },
    [cwd, stageFiles, clearSelection, selectedFile, setSelectedStaged]
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
        toast.error(`Failed to unstage: ${String(error)}`)
      } finally {
        setIsMutating(false)
      }
    },
    [cwd, unstageFiles, clearSelection, selectedFile, setSelectedStaged]
  )

  // Per-hunk stage/unstage (#257). The patch is built by GitDiffView from
  // the displayed diff and applied to the index without touching the rest
  // of the file. After mutation, fetchDiff re-loads the (now smaller) diff
  // so the panel reflects the partial stage. The same handlers serve both
  // the hunk-level and the per-line (Phase 2) actions; boundary + failure
  // logs carry non-sensitive metadata only (operation, patch size).
  const runStageHunk = useCallback(
    async (patch: string) => {
      if (!selectedFile || generationInFlight.current || hunkInFlight.current) return
      hunkInFlight.current = true
      setIsMutating(true)
      void logFrontendError({
        level: 'warn',
        source: 'GitPanel.runStageHunk',
        message: `dispatch: stage patch (${patch.split('\n').length} lines)`
      })
      try {
        await stageHunk(cwd, selectedFile, patch)
        await fetchDiff(cwd, selectedFile, false)
      } catch (error) {
        void logFrontendError({
          level: 'warn',
          source: 'GitPanel.runStageHunk',
          message: 'failed: git apply rejected the patch (details surfaced via UI toast only)'
        })
        toast.error(`Failed to stage hunk: ${String(error)}`)
      } finally {
        setIsMutating(false)
        hunkInFlight.current = false
      }
    },
    [cwd, selectedFile, stageHunk, fetchDiff]
  )

  const runUnstageHunk = useCallback(
    async (patch: string) => {
      if (!selectedFile || generationInFlight.current || hunkInFlight.current) return
      hunkInFlight.current = true
      setIsMutating(true)
      void logFrontendError({
        level: 'warn',
        source: 'GitPanel.runUnstageHunk',
        message: `dispatch: unstage patch (${patch.split('\n').length} lines)`
      })
      try {
        await unstageHunk(cwd, selectedFile, patch)
        await fetchDiff(cwd, selectedFile, true)
      } catch (error) {
        void logFrontendError({
          level: 'warn',
          source: 'GitPanel.runUnstageHunk',
          message: 'failed: git apply rejected the patch (details surfaced via UI toast only)'
        })
        toast.error(`Failed to unstage hunk: ${String(error)}`)
      } finally {
        setIsMutating(false)
        hunkInFlight.current = false
      }
    },
    [cwd, selectedFile, unstageHunk, fetchDiff]
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
      toast.error(`Failed to discard changes: ${String(error)}`)
    } finally {
      setIsMutating(false)
      setConfirmDiscardOpen(false)
      setDiscardTargets([])
    }
  }, [
    cwd,
    discardTargets,
    discardFiles,
    selectedFile,
    setSelectedFile,
    setSelectedStaged,
    clearSelection
  ])

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
      toast.error('Configure and select an ACP agent before generating a commit message')
      return
    }
    if (stagedCount === 0) {
      toast.error('Stage files before generating a commit message')
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
        throw new Error('Staged files changed. Refresh Git status and retry')
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
        throw new Error('Staged files or repository changed during generation. Retry')
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
        throw new Error('The staged diff is empty. Refresh Git status and retry')
      }
      if (stagedDiff.length > MAX_COMMIT_MESSAGE_DIFF_CHARS) {
        throw new Error(
          `The staged diff is too large to generate safely (${stagedDiff.length.toLocaleString()} characters; limit ${MAX_COMMIT_MESSAGE_DIFF_CHARS.toLocaleString()})`
        )
      }
      const generated = await generateCommitMessage(requestedCwd, stagedDiff)
      if (currentCwd.current !== requestedCwd || generationToken.current !== requestedToken) {
        throw new Error('Repository changed during generation. Generated message was discarded')
      }
      setSummary(generated.summary)
      setDescription(generated.description)
      toast.success('Commit message generated')
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
      toast.success(amend ? 'Commit amended' : 'Changes committed')
    } catch (error) {
      toast.error(`Failed to commit: ${String(error)}`)
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
      toast.success('Pushed to remote')
    } catch (error) {
      toast.error(`Failed to push: ${String(error)}`)
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
        toast.success(`Switched to branch ${name}`)
      } catch (error) {
        toast.error(`Failed to switch branch: ${String(error)}`)
      } finally {
        setIsMutating(false)
      }
    },
    [cwd, branchSwitch, hasUncommittedChanges]
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
            toast.success(`Switched to branch ${name} and reapplied changes`)
          } catch (popErr) {
            console.error('Auto-stash pop failed:', popErr)
            toast.warning(
              `Switched to branch ${name}, but changes were left in stash@{0} due to conflicts`
            )
          }
        } else {
          await branchSwitch(cwd, name)
          toast.success(`Switched to branch ${name} (changes carried over)`)
        }
      } catch (error) {
        toast.error(`Failed to switch branch: ${String(error)}`)
      } finally {
        setIsMutating(false)
        setPendingBranchName('')
      }
    },
    [cwd, pendingBranchName, branchSwitch, stashSave, stashPop]
  )

  const handleCreateBranch = useCallback(async () => {
    if (generationInFlight.current) return
    const name = branchNameInput.trim()
    if (!name) return
    setIsMutating(true)
    try {
      await branchCreate(cwd, name)
      toast.success(`Created and switched to branch ${name}`)
      setIsCreateBranchOpen(false)
      setBranchNameInput('')
    } catch (error) {
      toast.error(`Failed to create branch: ${String(error)}`)
    } finally {
      setIsMutating(false)
    }
  }, [cwd, branchNameInput, branchCreate])

  const handleStashSave = useCallback(async () => {
    if (generationInFlight.current) return
    const msg = stashMessage.trim() || undefined
    setIsMutating(true)
    try {
      await stashSave(cwd, msg, stashIncludeUntracked)
      toast.success('Changes stashed successfully')
      setIsStashOpen(false)
      setStashMessage('')
      setStashIncludeUntracked(false)
    } catch (error) {
      toast.error(`Failed to stash changes: ${String(error)}`)
    } finally {
      setIsMutating(false)
    }
  }, [cwd, stashMessage, stashIncludeUntracked, stashSave])

  const handleApplyStash = useCallback(
    async (index: number) => {
      if (generationInFlight.current) return
      setIsMutating(true)
      try {
        await stashApply(cwd, index)
        toast.success(`Stash@{${index}} applied`)
      } catch (error) {
        toast.error(`Failed to apply stash: ${String(error)}`)
      } finally {
        setIsMutating(false)
      }
    },
    [cwd, stashApply]
  )

  const handlePopStash = useCallback(
    async (index: number) => {
      if (generationInFlight.current) return
      setIsMutating(true)
      try {
        await stashPop(cwd, index)
        toast.success(`Stash@{${index}} popped`)
      } catch (error) {
        toast.error(`Failed to pop stash: ${String(error)}`)
      } finally {
        setIsMutating(false)
      }
    },
    [cwd, stashPop]
  )

  const handleDropStash = useCallback(
    async (index: number) => {
      if (generationInFlight.current) return
      setIsMutating(true)
      try {
        await stashDrop(cwd, index)
        toast.success(`Stash@{${index}} dropped`)
      } catch (error) {
        toast.error(`Failed to drop stash: ${String(error)}`)
      } finally {
        setIsMutating(false)
      }
    },
    [cwd, stashDrop]
  )

  return {
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
  }
}

export type GitActions = ReturnType<typeof useGitActions>
