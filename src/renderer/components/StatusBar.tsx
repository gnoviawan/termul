import { ConnectionStatusIndicator } from '@/components/ConnectionStatusIndicator'
import { ContextBarSettingsPopover } from '@/components/ContextBarSettingsPopover'
import { GitBranchPicker } from '@/components/GitBranchPicker'
import { Check, Download, FileQuestion, Folder, Pencil, Plus, X } from '@/components/icons'
import { ProjectIcon } from '@/components/ProjectIcon'
import { RemoteAccessPopover } from '@/components/RemoteAccessPopover'
import { STATUS_BAR_HOVER_CLASS, STATUS_BAR_ITEM_CLASS } from '@/components/status-bar-hit'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAgentChatProjectSignals } from '@/hooks/use-agent-chat-attention'
import { formatPath, useHomeDirectory } from '@/hooks/use-cwd'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { needsYouLabel } from '@/lib/agent-chat-attention'
import { isTauriContext } from '@/lib/tauri-runtime'
import { cn } from '@/lib/utils'
import { useAcpStore, useSessionIndexTitle } from '@/stores/acp-store'
import {
  useShowExitCode,
  useShowGitBranch,
  useShowGitStatus,
  useShowWorkingDirectory
} from '@/stores/context-bar-settings-store'
import { useActiveTerminal } from '@/stores/terminal-store'
import { useUpdateDownloaded, useUpdateVersion } from '@/stores/updater-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { Project } from '@/types/project'

interface StatusBarProps {
  project: Project | undefined
}

export function StatusBar({ project }: StatusBarProps): React.JSX.Element {
  const isMobileWebShell = useMobileWebShell()
  const activeTerminal = useActiveTerminal()
  const homeDir = useHomeDirectory()

  // Context bar visibility settings
  const showGitBranch = useShowGitBranch()
  const showGitStatus = useShowGitStatus()
  const showWorkingDirectory = useShowWorkingDirectory()
  const showExitCode = useShowExitCode()

  // Updater state
  const updateDownloaded = useUpdateDownloaded()
  const updateVersion = useUpdateVersion()

  // Display terminal CWD if available, otherwise fall back to project path
  const displayPath = activeTerminal?.cwd || project?.path
  const formattedPath = displayPath ? formatPath(displayPath, homeDir) : undefined

  // Display terminal git branch if available, otherwise fall back to project gitBranch
  const gitBranch = activeTerminal?.gitBranch ?? project?.gitBranch

  // Git status from active terminal
  const gitStatus = activeTerminal?.gitStatus

  // Last command exit code from active terminal
  const lastExitCode = activeTerminal?.lastExitCode

  return (
    <div
      data-status-bar=""
      // Quiet bar (redesign): card surface + hairline, muted ink. The
      // project colour lives in the glyph, not in the bar fill.
      className="relative z-50 flex h-7 shrink-0 select-none items-center gap-0.5 border-t border-border bg-card px-1.5 font-sans text-2xs text-muted-foreground"
    >
      {/* Left side */}
      <div className="flex items-center gap-0.5 min-w-0">
        {project && !isMobileWebShell && (
          <>
            <StatusItem
              icon={<ProjectIcon project={project} size={14} />}
              interactive={false}
              className="max-w-40 font-medium text-secondary-foreground"
            >
              <span className="truncate leading-none">
                {project.name.toLowerCase().replace(/\s+/g, '-')}
              </span>
            </StatusItem>

            {showGitBranch && displayPath && (
              <GitBranchPicker
                repoPath={displayPath}
                currentBranch={gitBranch}
                projectId={project.id}
                ahead={gitStatus?.ahead}
                behind={gitStatus?.behind}
              />
            )}

            {showGitStatus && gitStatus?.hasChanges && (
              <GitStatusIndicator
                modified={gitStatus.modified}
                staged={gitStatus.staged}
                untracked={gitStatus.untracked}
              />
            )}

            {showWorkingDirectory && formattedPath && (
              <StatusTooltip
                content={displayPath}
                className="min-w-0"
                contentClassName="max-w-md break-all"
              >
                <StatusItem
                  icon={<Folder size={12} />}
                  className="max-w-64 font-normal text-muted-foreground/70"
                >
                  <span className="truncate leading-none">{formattedPath}</span>
                </StatusItem>
              </StatusTooltip>
            )}
          </>
        )}
      </div>

      <div className="flex-1 min-w-2" />

      {/* Right side */}
      <div className="flex items-center gap-0.5 shrink-0">
        {project && !isMobileWebShell && <NeedsYouPill projectId={project.id} />}

        {/* Story 10 (F1): global web connection health (control + terminal
            channels). Renders null on Tauri desktop. */}
        <ConnectionStatusIndicator />

        {/* #843: "Remote terminal access" is the desktop shared-live host's
            own status — a web client served by termul-server has no
            shared-live host to inspect, so hide the popover instead of
            rendering a dead desktop-only control. */}
        {isTauriContext() && <RemoteAccessPopover />}

        {showExitCode && lastExitCode !== null && lastExitCode !== undefined && (
          <StatusTooltip
            content={
              lastExitCode === 0
                ? 'Last command succeeded'
                : `Last command failed with exit code ${lastExitCode}`
            }
          >
            <StatusItem className="tabular-nums">
              {lastExitCode === 0 ? (
                <Check size={12} className="shrink-0" aria-hidden="true" />
              ) : (
                <X size={12} className="shrink-0" aria-hidden="true" />
              )}
              <span className="leading-none">Exit {lastExitCode}</span>
            </StatusItem>
          </StatusTooltip>
        )}

        {updateDownloaded && (
          <StatusTooltip content={`Update ready to install (version ${updateVersion})`}>
            <StatusItem icon={<Download size={12} />} className="text-secondary-foreground">
              <span className="leading-none">Update ready</span>
            </StatusItem>
          </StatusTooltip>
        )}

        {/* Divider before the trailing icon controls. */}
        <span aria-hidden="true" className="mx-1 h-3 w-px shrink-0 bg-border" />
        <ContextBarSettingsPopover />
      </div>
    </div>
  )
}

interface StatusItemProps {
  icon?: React.ReactNode
  children: React.ReactNode
  className?: string
  /** False for plain labels with no action (no hover wash, default cursor). */
  interactive?: boolean
}

function StatusItem({
  icon,
  children,
  className,
  interactive = true
}: StatusItemProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'relative',
        STATUS_BAR_ITEM_CLASS,
        interactive ? STATUS_BAR_HOVER_CLASS : 'cursor-default',
        // #859: the bar is h-7 so the 24px items sit flush; an invisible
        // pseudo-element grows each tap target to ~44px vertically without
        // changing the 28px-high bar layout.
        "after:absolute after:-inset-y-2.5 after:inset-x-0 after:content-['']",
        className
      )}
    >
      {icon && <span className="flex shrink-0 items-center">{icon}</span>}
      {children}
    </div>
  )
}

/**
 * Top tooltip around a status-bar item. The wrapper div is the trigger's ref
 * target (`StatusItem` does not forward refs).
 */
function StatusTooltip({
  content,
  className = 'shrink-0',
  contentClassName,
  children
}: {
  content: React.ReactNode
  /** Wrapper sizing: `shrink-0` by default, `min-w-0` for a truncating item. */
  className?: string
  contentClassName?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn('flex items-center', className)}>{children}</div>
      </TooltipTrigger>
      <TooltipContent side="top" className={contentClassName}>
        {content}
      </TooltipContent>
    </Tooltip>
  )
}

interface GitStatusIndicatorProps {
  modified: number
  staged: number
  untracked: number
}

/** One count per git file state, in display order. The key is also the tooltip noun. */
const GIT_STATUS_COUNTS = [
  { key: 'modified', Icon: Pencil, iconClassName: 'text-diff-modified' },
  { key: 'staged', Icon: Plus, iconClassName: 'text-diff-added' },
  { key: 'untracked', Icon: FileQuestion, iconClassName: 'text-muted-foreground' }
] as const

function GitStatusIndicator(counts: GitStatusIndicatorProps): React.JSX.Element | null {
  const visible = GIT_STATUS_COUNTS.filter(({ key }) => counts[key] > 0)
  if (visible.length === 0) return null

  return (
    <div className={cn(STATUS_BAR_ITEM_CLASS, 'gap-2 tabular-nums', STATUS_BAR_HOVER_CLASS)}>
      {visible.map(({ key, Icon, iconClassName }) => {
        const count = counts[key]
        return (
          <Tooltip key={key}>
            <TooltipTrigger asChild>
              <span className="flex items-center gap-1">
                <Icon size={12} className={cn('shrink-0', iconClassName)} />
                <span className="min-w-[2ch] tabular-nums leading-none">{count}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              {count} {key} {count === 1 ? 'file' : 'files'}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

/**
 * "<chat> needs you" pill for the active project. Reuses the same signal as
 * the sidebar needs-you badge; clicking opens that chat in the active pane.
 */
function NeedsYouPill({ projectId }: { projectId: string }): React.JSX.Element | null {
  const { attentionCounts, firstNeedsYouSessionId } = useAgentChatProjectSignals()
  const count = attentionCounts[projectId] ?? 0
  const sessionId = firstNeedsYouSessionId[projectId]
  if (count <= 0 || !sessionId) return null
  return <NeedsYouPillButton sessionId={sessionId} count={count} />
}

function NeedsYouPillButton({
  sessionId,
  count
}: {
  sessionId: string
  count: number
}): React.JSX.Element {
  const sessionTitle = useAcpStore((state) => state.sessions[sessionId]?.title ?? null)
  const indexTitle = useSessionIndexTitle(sessionId)
  const chatName = sessionTitle ?? indexTitle ?? 'Agent chat'
  const label = count === 1 ? `${chatName} needs you` : needsYouLabel(count)
  return (
    <button
      type="button"
      onClick={() => useWorkspaceStore.getState().addAgentChatTab(sessionId)}
      className={cn(
        'flex h-6 min-w-0 max-w-56 shrink items-center gap-1.5 rounded-md bg-warning/10 px-2 font-medium text-warning transition-colors duration-150 ease-out hover:bg-warning/20',
        FOCUS_RING_CLASS
      )}
      aria-label={label}
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warning" />
      <span className="truncate leading-none">{label}</span>
    </button>
  )
}
