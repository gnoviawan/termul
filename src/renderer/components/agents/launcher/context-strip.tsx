import type { BaseBranchInfo } from '@shared/types/worktree.types'
import type { Dispatch, SetStateAction } from 'react'
import { Folder, FolderGit2, GitBranch } from '@/components/icons'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { WriteGate } from '@/components/ui/write-gate'
import { OUTSIDE_PROJECT_ROOT_REASON } from '@/lib/active-worktree'
import { cn } from '@/lib/utils'
import { worktreeLabel } from '@/lib/workspace-rows'
import type { Worktree } from '@/types/project'
import { STRIP_MENU_ITEM_CLASS, STRIP_TRIGGER_CLASS } from './launcher-classes'
import type { LaunchWorkspace } from './use-launch-workspace'

const NO_WORKTREES_REASON = 'No worktrees yet'

/** Why the Existing worktree item is unavailable, or `undefined` when usable. */
function existingDisabledReason(worktrees: readonly Worktree[]): string | undefined {
  if (worktrees.length === 0) return NO_WORKTREES_REASON
  if (worktrees.every((w) => w.outsideProjectRoot === true)) return OUTSIDE_PROJECT_ROOT_REASON
  return undefined
}

/**
 * Context strip tucked under the composer card (CAP-2) — always present, like
 * the chat composer's workspace strip. When worktree launches are available
 * (`interactive`) it carries the Workspace chip (Current checkout, Existing
 * worktree or New worktree) and, per mode, the checkout's branch, the
 * worktree picker or the base-branch picker. Otherwise it degrades to the chat
 * strip's read-only workspace + branch text so both surfaces agree on "there
 * is always a strip" (a non-git project shows just Local, a git project adds
 * its branch or Detached HEAD).
 */
export function LauncherContextStrip({
  workspace,
  worktrees,
  baseBranch,
  setBaseBranch,
  baseBranchInfo,
  baseOptions,
  interactive,
  newWorktreeDisabledReason,
  gitBranch,
  isGitRepo
}: {
  /** Chip mode and the selected existing worktree (`useLaunchWorkspace`). */
  workspace: Pick<
    LaunchWorkspace,
    'isolationMode' | 'setIsolationMode' | 'existingWorktreeId' | 'setExistingWorktreeId'
  >
  /** The project's listed worktrees (Existing worktree picker). */
  worktrees: readonly Worktree[]
  baseBranch: string | null
  setBaseBranch: Dispatch<SetStateAction<string | null>>
  baseBranchInfo: BaseBranchInfo | null
  baseOptions: { value: string; label: string }[]
  /** Git project — the pickers mount; else read-only text. */
  interactive: boolean
  /** When set, the "New worktree" option stays visible but disabled and this
      reason is exposed on hover and to assistive tech (write-gated server). */
  newWorktreeDisabledReason?: string
  /** Reactive project branch (the same fallback the chat strip reads). */
  gitBranch: string | null
  isGitRepo: boolean
}): React.JSX.Element {
  const { isolationMode, setIsolationMode, existingWorktreeId, setExistingWorktreeId } = workspace
  const existingReason = existingDisabledReason(worktrees)

  return (
    <div
      data-agent-launcher-context-strip="true"
      className="relative z-0 mx-auto -mt-4 flex w-[calc(100%-2.75rem)] min-w-0 items-center justify-between gap-2 rounded-b-2xl border border-t-0 border-border/60 bg-card/60 px-2 pb-1 pt-5"
    >
      {interactive ? (
        <>
          <Select
            value={isolationMode}
            onValueChange={(value) =>
              value === 'current' || value === 'existing' || value === 'worktree'
                ? setIsolationMode(value)
                : undefined
            }
          >
            <SelectTrigger aria-label="Workspace" className={STRIP_TRIGGER_CLASS}>
              {isolationMode === 'current' ? (
                <Folder className="size-3.5 shrink-0" />
              ) : (
                <FolderGit2 className="size-3.5 shrink-0" />
              )}
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="current" className={STRIP_MENU_ITEM_CLASS}>
                Current checkout
              </SelectItem>
              <div title={existingReason} className="flex w-full">
                <SelectItem
                  value="existing"
                  className={STRIP_MENU_ITEM_CLASS}
                  disabled={!!existingReason}
                  aria-description={existingReason}
                >
                  Existing worktree
                </SelectItem>
              </div>
              <WriteGate
                gated={!!newWorktreeDisabledReason}
                focusable={false}
                className="flex w-full"
              >
                <SelectItem
                  value="worktree"
                  className={STRIP_MENU_ITEM_CLASS}
                  disabled={!!newWorktreeDisabledReason}
                  aria-description={newWorktreeDisabledReason}
                >
                  New worktree
                </SelectItem>
              </WriteGate>
            </SelectContent>
          </Select>

          {isolationMode === 'current' && (
            <span
              className="ml-auto inline-flex min-w-0 items-center justify-end gap-1.5 px-2.5 text-xs text-muted-foreground"
              title={gitBranch ?? 'HEAD is not on a branch'}
            >
              <GitBranch size={13} className="shrink-0" aria-hidden="true" />
              <span className="sr-only">Branch: </span>
              <span className="truncate">{gitBranch ?? 'Detached HEAD'}</span>
            </span>
          )}

          {isolationMode === 'existing' && (
            <div className="flex min-w-0 items-center justify-end gap-2">
              <Select
                value={existingWorktreeId ?? ''}
                onValueChange={(value) => setExistingWorktreeId(value)}
              >
                <SelectTrigger
                  aria-label="Worktree"
                  className={cn(STRIP_TRIGGER_CLASS, 'min-w-0 [&>span]:truncate')}
                >
                  <GitBranch className="size-3.5 shrink-0" />
                  <SelectValue placeholder="Select worktree" />
                </SelectTrigger>
                <SelectContent>
                  {worktrees.map((w) => (
                    <div
                      key={w.id}
                      title={w.outsideProjectRoot ? OUTSIDE_PROJECT_ROOT_REASON : w.path}
                      className="flex w-full"
                    >
                      <SelectItem
                        value={w.id}
                        className={STRIP_MENU_ITEM_CLASS}
                        disabled={w.outsideProjectRoot === true}
                        aria-description={
                          w.outsideProjectRoot ? OUTSIDE_PROJECT_ROOT_REASON : undefined
                        }
                      >
                        {worktreeLabel(w)}
                      </SelectItem>
                    </div>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {isolationMode === 'worktree' && (
            <div className="flex min-w-0 items-center justify-end gap-2">
              {!baseBranch && baseBranchInfo?.isDetached && (
                <span className="truncate text-xs text-destructive">
                  Detached HEAD - pick a base
                </span>
              )}
              <Select value={baseBranch ?? ''} onValueChange={(value) => setBaseBranch(value)}>
                <SelectTrigger
                  aria-label="Base branch"
                  className={cn(STRIP_TRIGGER_CLASS, 'min-w-0 [&>span]:truncate')}
                >
                  <GitBranch className="size-3.5 shrink-0" />
                  <SelectValue placeholder="Base branch" />
                </SelectTrigger>
                <SelectContent>
                  {baseOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value} className={STRIP_MENU_ITEM_CLASS}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </>
      ) : (
        <>
          <span
            className="inline-flex shrink-0 items-center gap-1.5 px-2.5"
            title="Agent edits files in your project folder directly"
          >
            <Folder size={13} className="shrink-0" aria-hidden="true" />
            <span className="sr-only">Workspace: </span>
            Local
          </span>
          {(gitBranch || isGitRepo) && (
            <span
              className="ml-auto inline-flex min-w-0 items-center justify-end gap-1.5 px-2.5"
              title={gitBranch ?? 'HEAD is not on a branch'}
            >
              <GitBranch size={13} className="shrink-0" aria-hidden="true" />
              <span className="sr-only">Branch: </span>
              <span className="truncate">{gitBranch ?? 'Detached HEAD'}</span>
            </span>
          )}
        </>
      )}
    </div>
  )
}
