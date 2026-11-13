import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, FileDiff, TerminalSquare } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { DiffStatCounts } from '@/components/ui/diff-stat-counts'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import type { ToolCall } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import { useAcpStore } from '@/stores/acp-store'
import type { ChatMessage } from '@/stores/acp-store/types'
import { useOverlayRegistration } from '@/stores/overlay-stack-store'
import { BackgroundCommandRow } from './BackgroundCommandRow'
import { sessionBackgroundCommands } from './background-commands'
import { ChangedFilesRows, openChangedFile } from './ChangedFilesList'
import {
  STATUS_CHIP_ICON_CLASS,
  StatusChip,
  StatusChipCount,
  StatusChipDot,
  StatusChipLabel,
  StatusChipPanelHeader,
  StatusChipPanelNote,
  StatusChipRow,
  type StatusChipTone
} from './StatusChip'
import { SubagentRow, subagentCountSummary } from './SubagentRow'
import { SubagentRowStop } from './SubagentRowStop'
import type { SubagentCounts } from './subagent-strip'
import { useChatChangedFiles } from './use-chat-changed-files'
import { useBackgroundWait, useCurrentTurnSubagents } from './use-current-turn-subagents'

export type StatusKind = 'subagents' | 'background' | 'changes'

/** Changed files shown before "View all". */
const FILES_PREVIEW = 5

interface ChatStatusChipsProps {
  sessionId: string
  cwd: string
  toolCalls: ToolCall[]
  messages: readonly ChatMessage[]
  /** Session `activeTurn`: a subagent with no status yet counts as running while true; its end refreshes git state. */
  turnActive: boolean
  /**
   * "Review changes" in the Changes panel: opens the Git view (the Changes
   * tab on desktop, the Git sheet on the phone). Called with the chip, which
   * the Git sheet returns focus to. Without it the action is not shown.
   */
  onOpenGitChanges?: (opener: HTMLElement) => void
  /** Hide the chips (phone keyboard open, reconnect notice showing). */
  hidden?: boolean
  /** False while the chat tab is hidden (tabs stay mounted); closes the panel. */
  isVisible?: boolean
  className?: string
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** Dot for the subagents chip: amber while one works, then red, green, grey. */
function subagentTone(counts: SubagentCounts): StatusChipTone {
  if (counts.running > 0) return 'running'
  if (counts.failed > 0) return 'failed'
  if (counts.done > 0) return 'done'
  return 'idle'
}

/**
 * Status chips above the composer: Subagent, Background and Changes, each
 * shown only while its list has rows, in that order. A chip opens its own
 * panel just above it (one at a time); the dot says if something still runs.
 */
export function ChatStatusChips({
  sessionId,
  cwd,
  toolCalls,
  messages,
  turnActive,
  onOpenGitChanges,
  hidden = false,
  isVisible = true,
  className
}: ChatStatusChipsProps): React.JSX.Element | null {
  const isMobile = useMobileWebShell()
  const [openKind, setOpenKind] = useState<StatusKind | null>(null)
  const [showAllFiles, setShowAllFiles] = useState(false)
  const changesChipRef = useRef<HTMLButtonElement>(null)
  // Set while focus is handed to the Git view, so closing this panel does not
  // pull focus back to the chip.
  const handingOffFocus = useRef(false)

  const changes = useChatChangedFiles(cwd, toolCalls, turnActive)
  const { subagents, backgroundRunning, statuses, counts } = useCurrentTurnSubagents(
    toolCalls,
    messages,
    turnActive
  )
  const waiting = useBackgroundWait(sessionId, backgroundRunning, turnActive)
  const waitingLabel = waiting > 0 ? `Waiting on ${plural(waiting, 'background subagent')}` : null
  const commands = useAcpStore((s) => sessionBackgroundCommands(s.sessions[sessionId]))
  const commandsRunning = commands.filter((command) => command.state === 'running').length
  const commandsEnded = commands.length - commandsRunning
  const commandSummary = [
    commandsRunning > 0 && `${commandsRunning} running`,
    commandsEnded > 0 && `${commandsEnded} ended`
  ]
    .filter(Boolean)
    .join(', ')
  const backgroundLabel =
    commandsRunning > 0
      ? `${commandsRunning === 1 ? '1 command' : `${commandsRunning} commands`} running in the background`
      : null
  const fileCount = changes.files.length
  const rowCount: Record<StatusKind, number> = {
    subagents: subagents.length,
    background: commands.length,
    changes: fileCount
  }
  const shown = !hidden && (subagents.length > 0 || commands.length > 0 || fileCount > 0)
  const activeKind = openKind && shown && rowCount[openKind] > 0 ? openKind : null

  const close = useCallback(() => setOpenKind(null), [])
  const openChange = (kind: StatusKind) => (next: boolean) => {
    setOpenKind(next ? kind : null)
    if (kind === 'changes' && !next) setShowAllFiles(false)
  }
  useOverlayRegistration('chat-status-sheet', isMobile && activeKind !== null, close)
  // Hidden tabs stay mounted and the panel renders in a portal, so close it
  // or it would float over the next tab. A chip whose last row went away
  // takes its panel with it.
  useEffect(() => {
    if (!isVisible || (openKind && activeKind === null)) setOpenKind(null)
  }, [isVisible, openKind, activeKind])

  const subagentIds = useMemo(() => subagents.map((tc) => tc.toolCallId), [subagents])
  const subagentSummary = subagentCountSummary(counts)
  const hasTotals = changes.totalAdded > 0 || changes.totalRemoved > 0
  const listClassName = isMobile ? 'max-h-[min(22.5rem,55dvh)]' : 'max-h-72'
  const visibleFiles = showAllFiles ? changes.files : changes.files.slice(0, FILES_PREVIEW)
  const hiddenFiles = fileCount - visibleFiles.length

  const liveText = shown
    ? [subagents.length > 0 && (waitingLabel ?? `Subagents: ${subagentSummary}`), backgroundLabel]
        .filter(Boolean)
        .join('. ')
    : ''

  return (
    <>
      <span aria-live="polite" className="sr-only">
        {liveText}
      </span>
      {shown && (
        <StatusChipRow className={className}>
          {subagents.length > 0 && (
            <StatusChip
              label={`Subagents: ${[subagentSummary, waitingLabel?.toLowerCase()].filter(Boolean).join('; ')}`}
              panelTitle="Subagents"
              hint={waitingLabel ?? undefined}
              open={activeKind === 'subagents'}
              onOpenChange={openChange('subagents')}
              sheet={isMobile}
              trigger={
                <>
                  <Bot size={14} className={STATUS_CHIP_ICON_CLASS} aria-hidden="true" />
                  <StatusChipLabel>Subagent</StatusChipLabel>
                  <StatusChipCount>{subagents.length}</StatusChipCount>
                  <StatusChipDot tone={subagentTone(counts)} />
                </>
              }
            >
              <StatusChipPanelHeader>{subagentSummary}</StatusChipPanelHeader>
              {waitingLabel && <StatusChipPanelNote>{waitingLabel}</StatusChipPanelNote>}
              <ul
                className={cn(
                  'scroller-thin flex flex-col overflow-y-auto overscroll-contain',
                  listClassName
                )}
              >
                {subagents.map((tc, i) => (
                  <li key={tc.toolCallId} className="flex min-w-0 items-center gap-1">
                    <div className="min-w-0 flex-1">
                      <SubagentRow
                        toolCall={tc}
                        status={statuses[i] ?? 'stopped'}
                        siblings={subagentIds}
                        surface="popover"
                        onOpen={close}
                      />
                    </div>
                    {isMobile && (
                      <SubagentRowStop toolCall={tc} status={statuses[i] ?? 'stopped'} />
                    )}
                  </li>
                ))}
              </ul>
            </StatusChip>
          )}

          {commands.length > 0 && (
            <StatusChip
              label={`Background commands: ${commandSummary}`}
              panelTitle="Background"
              hint={backgroundLabel ?? undefined}
              open={activeKind === 'background'}
              onOpenChange={openChange('background')}
              sheet={isMobile}
              trigger={
                <>
                  <TerminalSquare size={14} className={STATUS_CHIP_ICON_CLASS} aria-hidden="true" />
                  <StatusChipLabel>Background</StatusChipLabel>
                  <StatusChipCount>{commands.length}</StatusChipCount>
                  <StatusChipDot tone={commandsRunning > 0 ? 'running' : 'idle'} />
                </>
              }
            >
              <StatusChipPanelHeader>{commandSummary}</StatusChipPanelHeader>
              <ul
                className={cn(
                  'scroller-thin flex flex-col overflow-y-auto overscroll-contain',
                  listClassName
                )}
              >
                {commands.map((command) => (
                  <li key={command.toolCallId} className="min-w-0">
                    <BackgroundCommandRow sessionId={sessionId} command={command} onOpen={close} />
                  </li>
                ))}
              </ul>
              {commandsRunning > 0 && (
                <StatusChipPanelNote>
                  The agent gets each result when the command ends.
                </StatusChipPanelNote>
              )}
            </StatusChip>
          )}

          {fileCount > 0 && (
            <StatusChip
              label={`Changes: ${plural(fileCount, 'changed file')}`}
              panelTitle="Changed files"
              open={activeKind === 'changes'}
              onOpenChange={openChange('changes')}
              sheet={isMobile}
              triggerRef={changesChipRef}
              onCloseAutoFocus={(event) => {
                if (!handingOffFocus.current) return
                handingOffFocus.current = false
                event.preventDefault()
              }}
              trigger={
                <>
                  <FileDiff size={14} className={STATUS_CHIP_ICON_CLASS} aria-hidden="true" />
                  <StatusChipLabel>Changes</StatusChipLabel>
                  {hasTotals ? (
                    <>
                      <span className="font-mono tabular-nums @max-[420px]:hidden">
                        <DiffStatCounts added={changes.totalAdded} removed={changes.totalRemoved} />
                      </span>
                      <StatusChipCount className="hidden @max-[420px]:inline">
                        {fileCount}
                      </StatusChipCount>
                    </>
                  ) : (
                    <StatusChipCount>{fileCount}</StatusChipCount>
                  )}
                </>
              }
            >
              <StatusChipPanelHeader
                actions={
                  onOpenGitChanges && (
                    <Button
                      type="button"
                      size="xs"
                      onClick={() => {
                        const opener = changesChipRef.current
                        if (!opener) return
                        handingOffFocus.current = true
                        setOpenKind(null)
                        onOpenGitChanges(opener)
                      }}
                      className="shrink-0 px-2.5"
                    >
                      Review changes
                    </Button>
                  )
                }
              >
                {changes.source === 'git'
                  ? `${plural(fileCount, 'file')}, not committed`
                  : `${plural(fileCount, 'file')} edited this session`}
              </StatusChipPanelHeader>
              <ChangedFilesRows
                files={visibleFiles}
                rowBase={changes.rowBase}
                className={listClassName}
                onOpen={(path) => {
                  setOpenKind(null)
                  void openChangedFile(path)
                }}
              />
              {hiddenFiles > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAllFiles(true)}
                  className="mx-1 mb-1 flex h-7 items-center rounded-md px-2 text-2xs font-medium text-muted-foreground transition-colors duration-150 ease-out hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring motion-reduce:transition-none"
                >
                  View all {fileCount} files
                </button>
              )}
            </StatusChip>
          )}
        </StatusChipRow>
      )}
    </>
  )
}
