import { CHAT_GUTTER_X, CHAT_HIT_MIN_H } from '@/components/chat/chat-layout'
import { ChevronDown, ChevronRight, FileDiff } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import { DiffStatCounts } from '@/components/ui/diff-stat-counts'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import type { ToolCall } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import { ChangedFilesRows, openChangedFile } from './ChangedFilesList'
import { useChatChangedFiles } from './use-chat-changed-files'
import { useForcedCollapse } from './use-forced-collapse'

interface ChatChangedFilesPanelProps {
  cwd: string
  toolCalls: ToolCall[]
  /** The agent turn is running; its end refreshes git state. */
  turnActive?: boolean
  /**
   * Mobile dock: adds a "Git" action beside the header that opens the Git
   * sheet. It is called with the tapped button, which the Git sheet returns
   * focus to when it closes. When omitted (desktop) the header renders exactly
   * as before.
   */
  onOpenGitChanges?: (opener: HTMLElement) => void
  /**
   * Render collapsed while true (keyboard up with an approval pending). A
   * header tap during the window still flips the rendered state; afterwards
   * the panel shows the user's last own state.
   */
  forceCollapsed?: boolean
}

/**
 * Collapsible, scrollable "Changed files" panel anchored on top of the
 * ChatInputBar. In a git repository it lists the uncommitted files of the
 * checkout at `cwd` (staged, unstaged and untracked, against HEAD) with their
 * git line counts, so a committed, discarded or deleted file drops out and a
 * clean tree hides the panel. Outside a git repository it lists the files
 * touched by ACP tool calls (edit/delete/move) in the current session — a
 * file edited by several calls appears once with summed +N −N counts.
 * Clicking a row opens the file in the editor workspace; a deleted file's
 * row opens nothing. View-and-open-only.
 *
 * The panel sits behind the chatbox (z-0 vs z-10). A negative bottom margin
 * extends the panel's translucent bg-card/60 behind the chatbox's rounded top
 * corners, covering the transparent gap. The visible content has bottom
 * padding so text clears the overlap zone.
 */
export function ChatChangedFilesPanel({
  cwd,
  toolCalls,
  turnActive = false,
  onOpenGitChanges,
  forceCollapsed = false
}: ChatChangedFilesPanelProps): React.JSX.Element | null {
  const isMobileShell = useMobileWebShell()
  const { collapsed, toggle } = useForcedCollapse(true, forceCollapsed)
  const expanded = !collapsed

  const { files, rowBase, totalAdded, totalRemoved } = useChatChangedFiles(
    cwd,
    toolCalls,
    turnActive
  )
  const count = files.length
  const hasTotalCounts = totalAdded > 0 || totalRemoved > 0

  if (count === 0) return null

  const toggleButton = (
    <button
      type="button"
      data-press-feedback="off"
      onClick={toggle}
      className={cn(
        'flex w-full items-center gap-2 rounded-t-2xl px-3 text-left',
        CHAT_HIT_MIN_H,
        onOpenGitChanges && 'min-w-0 flex-1',
        // The composer covers the bottom 24px of the collapsed bar (-mb-6), so
        // the strip left to tap is `pt + line + pb - 24px`. With the Git action
        // that strip must reach 44px for its hit area (the card clips its
        // slop above): pt-4 + pb-9 leaves ~45px; without it, 32px as before.
        expanded ? 'py-2' : onOpenGitChanges ? 'pt-4 pb-9' : 'pt-2 pb-8',
        'cursor-pointer text-xs text-muted-foreground',
        'select-none appearance-none transition-[background-color,color] duration-150 ease-out',
        'hover:bg-secondary/60 hover:text-foreground',
        'active:bg-secondary/80',
        'focus-visible:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none'
      )}
      aria-expanded={expanded}
      // On mobile the visible text names the button ("Changed files 3 +17 −2").
      aria-label={
        isMobileShell ? undefined : expanded ? 'Collapse changed files' : 'Expand changed files'
      }
    >
      <ChevronDown
        size={14}
        className={cn(
          'shrink-0 transition-transform duration-[var(--acc-chevron)] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          expanded ? 'rotate-180' : 'rotate-0'
        )}
      />
      <FileDiff size={13} className="shrink-0 text-muted-foreground/70" />
      <span className="font-medium">Changed files</span>{' '}
      <span className="rounded-full bg-secondary px-1.5 py-0.5 text-3xs font-semibold tabular-nums">
        {count}
      </span>{' '}
      {hasTotalCounts && (
        <span className="ms-auto shrink-0 font-mono text-2xs tabular-nums">
          <DiffStatCounts added={totalAdded} removed={totalRemoved} />
        </span>
      )}
    </button>
  )

  return (
    <div className={cn(CHAT_GUTTER_X, '-mb-6 pt-0')}>
      <div className="relative mx-auto w-full max-w-3xl">
        <div className="relative z-0 overflow-hidden rounded-t-2xl border border-b-0 border-border/60 bg-card/60 select-none">
          {onOpenGitChanges ? (
            <div className="flex items-start">
              {toggleButton}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label="Open Git changes"
                onClick={(event) => onOpenGitChanges(event.currentTarget)}
                className="relative me-2 mt-2 shrink-0 text-muted-foreground after:absolute after:-inset-2 after:content-[''] [&_svg]:size-3"
              >
                Git
                <ChevronRight size={12} aria-hidden="true" />
              </Button>
            </div>
          ) : (
            toggleButton
          )}
          <CollapseExpandMotion open={expanded} motion="chat">
            <div className="pb-6">
              <div className="scroller-thin max-h-48 overflow-y-auto">
                <ChangedFilesRows files={files} rowBase={rowBase} onOpen={openChangedFile} />
              </div>
            </div>
          </CollapseExpandMotion>
        </div>
      </div>
    </div>
  )
}
