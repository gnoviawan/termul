import type { BranchInfo } from '@shared/types/ipc.types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  GitBranch,
  Globe,
  Plus,
  RefreshCw
} from '@/components/icons'
import {
  STATUS_BAR_HOVER_CLASS,
  STATUS_BAR_ITEM_CLASS,
  STATUS_BAR_OPEN_CLASS
} from '@/components/status-bar-hit'
import { Button } from '@/components/ui/button'
import { FOCUS_RING_CLASS, PANEL_FIELD_CLASS } from '@/components/ui/panel-styles'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PopoverSearchBand } from '@/components/ui/popover-search-band'
import { Spinner } from '@/components/ui/spinner'
import { gitApi } from '@/lib/git-api'
import { cn } from '@/lib/utils'
import { worktreeApi } from '@/lib/worktree-api'
import { useProjectStore } from '@/stores/project-store'
import { useTerminalStore } from '@/stores/terminal-store'

// Quiet status-bar item (redesign): neutral hover wash, open = popover tint.
const statusBarTriggerClass = cn(
  STATUS_BAR_ITEM_CLASS,
  STATUS_BAR_HOVER_CLASS,
  FOCUS_RING_CLASS,
  STATUS_BAR_OPEN_CLASS
)

const branchRowClass =
  'flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-foreground transition-colors duration-150 ease-out hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.06] focus-visible:outline-none disabled:cursor-default'

function sanitizeBranchName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9/_.-]/g, '-')
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '')
}

function formatBranchLoadError(error: string, code?: string): string {
  switch (code) {
    case 'NOT_A_GIT_REPO':
      return 'This folder is not a git repository.'
    case 'GIT_NOT_FOUND':
      return 'Git is not installed or not available on PATH.'
    default:
      return error
  }
}

interface GitBranchPickerProps {
  repoPath: string
  currentBranch: string | null | undefined
  projectId: string
  ahead?: number
  behind?: number
}

export function GitBranchPicker({
  repoPath,
  currentBranch,
  projectId,
  ahead = 0,
  behind = 0
}: GitBranchPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [branchSearch, setBranchSearch] = useState('')
  const [isSwitching, setIsSwitching] = useState(false)
  const [isCreatingMode, setIsCreatingMode] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const branchLoadRequestId = useRef(0)
  const latestRepoPath = useRef(repoPath)
  const latestOpen = useRef(open)
  latestRepoPath.current = repoPath
  latestOpen.current = open

  const updateProject = useProjectStore((state) => state.updateProject)
  const activeTerminalId = useTerminalStore((state) => state.activeTerminalId)
  const updateTerminalGitBranch = useTerminalStore((state) => state.updateTerminalGitBranch)

  const loadBranches = useCallback(async (): Promise<void> => {
    const requestId = branchLoadRequestId.current + 1
    branchLoadRequestId.current = requestId
    const requestRepoPath = repoPath
    const isCurrentRequest = (): boolean =>
      branchLoadRequestId.current === requestId &&
      latestRepoPath.current === requestRepoPath &&
      latestOpen.current

    setBranchesLoading(true)
    setLoadError(null)
    try {
      const result = await worktreeApi.branches(repoPath)
      if (!isCurrentRequest()) return

      if (result.success && result.data) {
        setBranches(result.data)
        setLoadError(null)
      } else if (result.success === false) {
        setBranches([])
        setLoadError(formatBranchLoadError(result.error, result.code))
      } else {
        setBranches([])
        setLoadError('Failed to load branches.')
      }
    } catch (error) {
      if (!isCurrentRequest()) return

      setBranches([])
      setLoadError(error instanceof Error ? error.message : 'Failed to load branches.')
    } finally {
      if (isCurrentRequest()) {
        setBranchesLoading(false)
      }
    }
  }, [repoPath])

  useEffect(() => {
    if (!open) {
      branchLoadRequestId.current += 1
      setIsCreatingMode(false)
      setNewBranchName('')
      setBranchSearch('')
      setLoadError(null)
      setBranchesLoading(false)
      return
    }
    void loadBranches()

    return () => {
      branchLoadRequestId.current += 1
    }
  }, [open, loadBranches])

  // Local branch short names - used to suppress remote duplicates
  const localBranchNames = useMemo(
    () => new Set(branches.filter((b) => !b.isRemote).map((b) => b.name)),
    [branches]
  )

  // Branches after structural filtering (symref removal, local-duplicate suppression)
  const visibleBranches = useMemo(
    () =>
      branches.filter((branch) => {
        // Skip symbolic refs like origin/HEAD
        if (branch.isRemote && branch.name.endsWith('/HEAD')) return false
        // Skip remote branches that already have a local counterpart
        if (branch.isRemote) {
          const slash = branch.name.indexOf('/')
          const shortName = slash >= 0 ? branch.name.slice(slash + 1) : branch.name
          if (localBranchNames.has(shortName)) return false
        }
        return true
      }),
    [branches, localBranchNames]
  )

  const filteredBranches = useMemo(() => {
    const query = branchSearch.trim().toLowerCase()
    return visibleBranches
      .filter((branch) => !query || branch.name.toLowerCase().includes(query))
      .sort((a, b) => {
        if (a.isCurrent) return -1
        if (b.isCurrent) return 1
        return a.name.localeCompare(b.name)
      })
  }, [visibleBranches, branchSearch])

  const emptyListMessage = useMemo((): string | null => {
    if (loadError || branchesLoading) return null
    if (visibleBranches.length === 0) return 'No branches yet.'
    if (branchSearch.trim() && filteredBranches.length === 0)
      return 'No branches match your search.'
    return null
  }, [branchSearch, branchesLoading, loadError, visibleBranches.length, filteredBranches.length])

  const canCreateBranch = !branchesLoading && !loadError

  const localBranches = useMemo(
    () => filteredBranches.filter((branch) => !branch.isRemote),
    [filteredBranches]
  )
  const remoteBranches = useMemo(
    () => filteredBranches.filter((branch) => branch.isRemote),
    [filteredBranches]
  )

  const resolveCheckedOutBranch = (branch: BranchInfo): string => {
    if (!branch.isRemote) return branch.name
    const slash = branch.name.indexOf('/')
    return slash >= 0 ? branch.name.slice(slash + 1) : branch.name
  }

  const handleBranchChanged = (branchName: string): void => {
    updateProject(projectId, { gitBranch: branchName })
    if (activeTerminalId) {
      updateTerminalGitBranch(activeTerminalId, branchName)
    }
  }

  const handleCheckout = async (branch: BranchInfo): Promise<void> => {
    if (branch.isCurrent || branch.hasOtherWorktree || isSwitching) return

    setIsSwitching(true)
    try {
      await gitApi.checkoutBranch(repoPath, branch.name, branch.isRemote)
      const checkedOut = resolveCheckedOutBranch(branch)
      handleBranchChanged(checkedOut)
      toast.success(`Switched to ${checkedOut}`)
      setOpen(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to switch branch')
    } finally {
      setIsSwitching(false)
    }
  }

  const handleCreateBranch = async (): Promise<void> => {
    if (branchesLoading) {
      toast.error('Wait for branches to finish loading')
      return
    }
    if (loadError) {
      toast.error('Branches must load successfully before creating a new branch')
      return
    }

    const sanitized = sanitizeBranchName(newBranchName.trim())
    if (!sanitized) {
      toast.error('Enter a valid branch name')
      return
    }

    setIsSwitching(true)
    try {
      await gitApi.createBranch(repoPath, sanitized)
      handleBranchChanged(sanitized)
      toast.success(`Created and checked out ${sanitized}`)
      setOpen(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create branch')
    } finally {
      setIsSwitching(false)
    }
  }

  const displayLabel = currentBranch ?? 'detached'

  const renderBranchRow = (branch: BranchInfo): React.JSX.Element => {
    const BranchIcon = branch.isRemote ? Globe : GitBranch
    return (
      <button
        key={branch.name}
        type="button"
        onClick={() => void handleCheckout(branch)}
        disabled={branch.isCurrent || branch.hasOtherWorktree || isSwitching}
        className={cn(branchRowClass, branch.hasOtherWorktree && 'opacity-50 cursor-not-allowed')}
        title={
          branch.hasOtherWorktree ? 'This branch is checked out in another worktree' : undefined
        }
        aria-current={branch.isCurrent ? 'true' : undefined}
      >
        <BranchIcon size={13} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{branch.name}</span>
        {branch.hasOtherWorktree && (
          <span className="text-3xs text-muted-foreground">worktree</span>
        )}
        {branch.isCurrent && (
          <Check size={13} className="shrink-0 text-foreground" aria-label="Current branch" />
        )}
      </button>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={statusBarTriggerClass}
          aria-label="Switch git branch"
          disabled={isSwitching}
        >
          <GitBranch size={12} className="shrink-0" />
          <span className="min-w-0 max-w-32 truncate leading-none text-secondary-foreground">
            {displayLabel}
          </span>
          {(ahead > 0 || behind > 0) && (
            <span className="flex shrink-0 items-center gap-1 tabular-nums text-muted-foreground/70">
              {ahead > 0 && <span className="leading-none">↑{ahead}</span>}
              {behind > 0 && <span className="leading-none">↓{behind}</span>}
            </span>
          )}
          {open ? (
            <ChevronUp size={10} className="shrink-0" />
          ) : (
            <ChevronDown size={10} className="shrink-0" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-80 overflow-hidden rounded-xl border bg-popover p-0 shadow-lg"
      >
        <PopoverSearchBand
          value={branchSearch}
          onChange={setBranchSearch}
          placeholder="Search branches"
          ariaLabel="Search branches"
          autoFocus
          inputClassName="h-full text-xs"
        />

        <div className="max-h-64 overflow-y-auto p-1">
          {branchesLoading ? (
            <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
              <Spinner size={14} decorative />
              Loading branches...
            </div>
          ) : loadError ? (
            <div className="space-y-2 px-3 py-4 text-center">
              <div className="flex items-start justify-center gap-1.5 text-xs text-muted-foreground">
                <AlertCircle size={13} className="mt-0.5 shrink-0 text-destructive" />
                <span className="text-left">{loadError}</span>
              </div>
              <button
                type="button"
                onClick={() => void loadBranches()}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground',
                  FOCUS_RING_CLASS
                )}
              >
                <RefreshCw size={12} />
                Retry
              </button>
            </div>
          ) : emptyListMessage ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              {emptyListMessage}
            </div>
          ) : (
            <>
              {localBranches.length > 0 && (
                <fieldset aria-label="Local branches" className="m-0 min-w-0 border-0 p-0">
                  <div className="label-panel px-3 pt-2 pb-1">Local</div>
                  {localBranches.map(renderBranchRow)}
                </fieldset>
              )}
              {remoteBranches.length > 0 && (
                <fieldset aria-label="Remote branches" className="m-0 min-w-0 border-0 p-0">
                  <div className="label-panel px-3 pt-2 pb-1">Remote</div>
                  {remoteBranches.map(renderBranchRow)}
                </fieldset>
              )}
            </>
          )}
        </div>

        <div className="border-t border-border p-1">
          {isCreatingMode ? (
            <div className="flex items-center gap-2 p-1">
              <input
                type="text"
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreateBranch()
                  if (e.key === 'Escape') setIsCreatingMode(false)
                }}
                placeholder="new-branch-name"
                aria-label="New branch name"
                className={cn(PANEL_FIELD_CLASS, 'h-8 min-w-0 flex-1 px-2.5')}
                autoFocus
                disabled={isSwitching}
              />
              <Button
                type="button"
                size="xs"
                onClick={() => void handleCreateBranch()}
                disabled={isSwitching || !canCreateBranch || !newBranchName.trim()}
              >
                Create
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setIsCreatingMode(true)}
              disabled={isSwitching || !canCreateBranch}
              className={cn(branchRowClass, 'text-muted-foreground hover:text-foreground')}
            >
              <Plus size={13} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                Create branch from{' '}
                <span className="text-foreground">{currentBranch ?? 'HEAD'}</span>
              </span>
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
