import type React from 'react'
import { useEffect } from 'react'
import { Check, ExternalLink, History } from '@/components/icons'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { formatRelativeTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'
import { normalizePath } from '@/lib/working-copy'
import { GIT_LOG_LIMIT, useGitHistoryStore } from '@/stores/git-history-store'
import { type GitStatusState, useGitStatusStore } from '@/stores/git-status-store'
import { findPaneContainingTab, gitHistoryTabId, useWorkspaceStore } from '@/stores/workspace-store'

/** The commit-context fields a commit or a branch switch changes, as one string. */
function headSignatureOf(state: Pick<GitStatusState, 'commitContexts'>, cwd: string): string {
  const context = state.commitContexts[normalizePath(cwd)]
  if (!context) return ''
  const { branch, hasHead, lastSubject, ahead, behind } = context
  return [branch, hasHead, lastSubject, ahead, behind].join('\u0000')
}

interface HistoryRowProps {
  cwd: string
  isVisible: boolean
}

/**
 * Bottom row of the shell Changes panel: the HEAD commit and the length of
 * the HEAD history. It reads through its own HEAD-scoped log, so the History
 * tab's scope does not change it, and reloads when the working copy's commit
 * context (branch, last subject, ahead/behind) changes, as after a commit. A
 * click opens (or focuses) the Git History tab in the main panel; a check
 * shows while that tab is open.
 */
export function HistoryRow({ cwd, isVisible }: HistoryRowProps): React.JSX.Element {
  const summary = useGitHistoryStore((state) => state.headSummary[cwd])
  const refreshHeadSummary = useGitHistoryStore((state) => state.refreshHeadSummary)
  const headSignature = useGitStatusStore((state) => headSignatureOf(state, cwd))
  const addGitHistoryTab = useWorkspaceStore((state) => state.addGitHistoryTab)
  const isOpen = useWorkspaceStore(
    (state) => findPaneContainingTab(state.root, gitHistoryTabId(cwd)) !== null
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: headSignature is the reload trigger, not a value read inside the effect.
  useEffect(() => {
    if (isVisible) void refreshHeadSummary(cwd)
  }, [isVisible, cwd, headSignature, refreshHeadSummary])

  const last = summary?.last
  const count = summary?.count ?? 0
  const countLabel =
    summary === undefined
      ? ''
      : `${count}${count >= GIT_LOG_LIMIT ? '+' : ''} ${count === 1 ? 'commit' : 'commits'}`

  return (
    <div className="shrink-0 border-t border-border p-2">
      <button
        type="button"
        onClick={() => addGitHistoryTab(cwd)}
        aria-label={isOpen ? 'History, open in the main panel' : 'Open History in the main panel'}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 ease-out hover:bg-foreground/[0.03]',
          FOCUS_RING_CLASS
        )}
      >
        <History size={15} className="shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <span className="text-xs text-foreground">History</span>
            <span className="flex-1" />
            <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
              {countLabel}
            </span>
          </span>
          <span className="truncate text-2xs text-muted-foreground">
            {last
              ? `${last.subject || '(no message)'} · ${formatRelativeTime(last.date)}`
              : summary === undefined
                ? 'Loading...'
                : 'No commits yet'}
          </span>
        </span>
        {isOpen ? (
          <Check size={14} className="shrink-0 text-foreground" />
        ) : (
          <ExternalLink size={14} className="shrink-0 text-muted-foreground" />
        )}
      </button>
    </div>
  )
}
