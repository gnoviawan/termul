import type { Dispatch, SetStateAction } from 'react'
import { Folder, FolderGit2, GitBranch } from '@/components/icons'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { BaseBranchInfo } from '@/lib/worktree-api'
import { STRIP_MENU_ITEM_CLASS, STRIP_TRIGGER_CLASS } from './launcher-classes'

/**
 * Context strip tucked under the composer card (CAP-2) — always present, like
 * the chat composer's workspace strip. When worktree launches are available
 * (`interactive`) it carries the isolation-mode picker (Local vs New
 * worktree) and, in worktree mode, the base-branch picker. Otherwise it
 * degrades to the chat strip's read-only workspace + branch text so both
 * surfaces agree on "there is always a strip" (a non-git project shows just
 * Local, a git project adds its branch or Detached HEAD).
 */
export function LauncherContextStrip({
  isolationMode,
  setIsolationMode,
  baseBranch,
  setBaseBranch,
  baseBranchInfo,
  baseOptions,
  interactive,
  gitBranch,
  isGitRepo
}: {
  isolationMode: 'current' | 'worktree'
  setIsolationMode: Dispatch<SetStateAction<'current' | 'worktree'>>
  baseBranch: string | null
  setBaseBranch: Dispatch<SetStateAction<string | null>>
  baseBranchInfo: BaseBranchInfo | null
  baseOptions: { value: string; label: string }[]
  /** Worktree launches available — the pickers mount; else read-only text. */
  interactive: boolean
  /** Reactive project branch (the same fallback the chat strip reads). */
  gitBranch: string | null
  isGitRepo: boolean
}): React.JSX.Element {
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
              value === 'current' || value === 'worktree' ? setIsolationMode(value) : undefined
            }
          >
            <SelectTrigger aria-label="Isolation mode" className={STRIP_TRIGGER_CLASS}>
              {isolationMode === 'worktree' ? (
                <FolderGit2 className="size-3.5 shrink-0" />
              ) : (
                <Folder className="size-3.5 shrink-0" />
              )}
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="current" className={STRIP_MENU_ITEM_CLASS}>
                Local
              </SelectItem>
              <SelectItem value="worktree" className={STRIP_MENU_ITEM_CLASS}>
                New worktree
              </SelectItem>
            </SelectContent>
          </Select>

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
