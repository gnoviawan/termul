import { useCallback, useMemo, useRef, useState } from 'react'
import { Bot, FileDiff, TerminalSquare } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { DiffStatCounts } from '@/components/ui/diff-stat-counts'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import type { BackgroundCommand, ToolCall } from '@/lib/acp-api'
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
import type { SubagentCounts, SubagentStatus } from './subagent-strip'
import { type ChatChangedFiles, useChatChangedFiles } from './use-chat-changed-files'
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

/** What every chip gets from the row: its open state and its surface. */
interface ChipBaseProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Phone shell: a bottom sheet in place of the popover. */
  sheet: boolean
  /** Max height of the scrolling list. */
  listClassName: string
}

function SubagentsChip({
  subagents,
  statuses,
  counts,
  waitingLabel,
  onRowOpen,
  ...base
}: ChipBaseProps & {
  subagents: ToolCall[]
  statuses: SubagentStatus[]
  counts: SubagentCounts
  waitingLabel: string | null
  onRowOpen: () => void
}): React.JSX.Element {
  const subagentIds = useMemo(() => subagents.map((tc) => tc.toolCallId), [subagents])
  const summary = subagentCountSummary(counts)
  return (
    <StatusChip
      label={`Subagents: ${[summary, waitingLabel?.toLowerCase()].filter(Boolean).join('; ')}`}
      panelTitle="Subagents"
      hint={waitingLabel ?? undefined}
      open={base.open}
      onOpenChange={base.onOpenChange}
      sheet={base.sheet}
      trigger={
        <>
          <Bot size={14} className={STATUS_CHIP_ICON_CLASS} aria-hidden="true" />
          <StatusChipLabel>Subagent</StatusChipLabel>
          <StatusChipCount>{subagents.length}</StatusChipCount>
          <StatusChipDot tone={subagentTone(counts)} />
        </>
      }
    >
      <StatusChipPanelHeader>{summary}</StatusChipPanelHeader>
      {waitingLabel && <StatusChipPanelNote>{waitingLabel}</StatusChipPanelNote>}
      <ul
        className={cn(
          'scroller-thin flex flex-col overflow-y-auto overscroll-contain',
          base.listClassName
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
                onOpen={onRowOpen}
              />
            </div>
            {base.sheet && <SubagentRowStop toolCall={tc} status={statuses[i] ?? 'stopped'} />}
          </li>
        ))}
      </ul>
    </StatusChip>
  )
}

function BackgroundChip({
  sessionId,
  commands,
  running,
  summary,
  hint,
  onRowOpen,
  ...base
}: ChipBaseProps & {
  sessionId: string
  commands: readonly BackgroundCommand[]
  running: number
  summary: string
  hint: string | null
  onRowOpen: () => void
}): React.JSX.Element {
  return (
    <StatusChip
      label={`Background commands: ${summary}`}
      panelTitle="Background"
      hint={hint ?? undefined}
      open={base.open}
      onOpenChange={base.onOpenChange}
      sheet={base.sheet}
      trigger={
        <>
          <TerminalSquare size={14} className={STATUS_CHIP_ICON_CLASS} aria-hidden="true" />
          <StatusChipLabel>Background</StatusChipLabel>
          <StatusChipCount>{commands.length}</StatusChipCount>
          <StatusChipDot tone={running > 0 ? 'running' : 'idle'} />
        </>
      }
    >
      <StatusChipPanelHeader>{summary}</StatusChipPanelHeader>
      <ul
        className={cn(
          'scroller-thin flex flex-col overflow-y-auto overscroll-contain',
          base.listClassName
        )}
      >
        {commands.map((command) => (
          <li key={command.toolCallId} className="min-w-0">
            <BackgroundCommandRow sessionId={sessionId} command={command} onOpen={onRowOpen} />
          </li>
        ))}
      </ul>
      {running > 0 && (
        <StatusChipPanelNote>The agent gets each result when the command ends.</StatusChipPanelNote>
      )}
    </StatusChip>
  )
}

function ChangesChip({
  changes,
  onOpenGitChanges,
  onClose,
  ...base
}: ChipBaseProps & {
  changes: ChatChangedFiles
  onOpenGitChanges?: (opener: HTMLElement) => void
  onClose: () => void
}): React.JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const chipRef = useRef<HTMLButtonElement>(null)
  // Set while focus is handed to the Git view, so closing this panel does not
  // pull focus back to the chip.
  const handingOffFocus = useRef(false)
  const fileCount = changes.files.length
  const hasTotals = changes.totalAdded > 0 || changes.totalRemoved > 0
  const visibleFiles = showAll ? changes.files : changes.files.slice(0, FILES_PREVIEW)
  const hiddenFiles = fileCount - visibleFiles.length

  return (
    <StatusChip
      label={`Changes: ${plural(fileCount, 'changed file')}`}
      panelTitle="Changed files"
      open={base.open}
      onOpenChange={(next) => {
        if (!next) setShowAll(false)
        base.onOpenChange(next)
      }}
      sheet={base.sheet}
      triggerRef={chipRef}
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
              <StatusChipCount className="hidden @max-[420px]:inline">{fileCount}</StatusChipCount>
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
                const opener = chipRef.current
                if (!opener) return
                handingOffFocus.current = true
                onClose()
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
        className={base.listClassName}
        onOpen={(path) => {
          onClose()
          void openChangedFile(path)
        }}
      />
      {hiddenFiles > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mx-1 mb-1 flex h-7 items-center rounded-md px-2 text-2xs font-medium text-muted-foreground transition-colors duration-150 ease-out hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring motion-reduce:transition-none"
        >
          View all {fileCount} files
        </button>
      )}
    </StatusChip>
  )
}

/**
 * Which chip has its panel open: one at a time. A hidden tab or a chip whose
 * last row went away closes it (adjusted during render, so it does not open
 * again when the chip comes back). On the phone the open sheet takes Back.
 */
function useOpenChip(
  rowCount: Record<StatusKind, number>,
  available: boolean,
  isMobile: boolean
): { base: (kind: StatusKind) => ChipBaseProps; close: () => void } {
  const [openKind, setOpenKind] = useState<StatusKind | null>(null)
  const activeKind = openKind && available && rowCount[openKind] > 0 ? openKind : null
  if (openKind !== null && activeKind === null) setOpenKind(null)

  const close = useCallback(() => setOpenKind(null), [])
  useOverlayRegistration('chat-status-sheet', isMobile && activeKind !== null, close)

  const listClassName = isMobile ? 'max-h-[min(22.5rem,55dvh)]' : 'max-h-72'
  const base = (kind: StatusKind): ChipBaseProps => ({
    open: activeKind === kind,
    onOpenChange: (next) => setOpenKind(next ? kind : null),
    sheet: isMobile,
    listClassName
  })
  return { base, close }
}

/** The session's background commands and how to say their state. */
function useBackgroundCommands(sessionId: string): {
  commands: readonly BackgroundCommand[]
  running: number
  /** "1 running, 2 ended". */
  summary: string
  /** "1 command running in the background", or null when none runs. */
  hint: string | null
} {
  const commands = useAcpStore((s) => sessionBackgroundCommands(s.sessions[sessionId]))
  const running = commands.filter((command) => command.state === 'running').length
  const ended = commands.length - running
  const parts: string[] = []
  if (running > 0) parts.push(`${running} running`)
  if (ended > 0) parts.push(`${ended} ended`)
  const hint =
    running > 0
      ? `${running === 1 ? '1 command' : `${running} commands`} running in the background`
      : null
  return { commands, running, summary: parts.join(', '), hint }
}

/** What the live region says while the chips show. */
function liveStatus(
  subagentCount: number,
  waitingLabel: string | null,
  counts: SubagentCounts,
  backgroundHint: string | null
): string {
  const parts: string[] = []
  if (subagentCount > 0) parts.push(waitingLabel ?? `Subagents: ${subagentCountSummary(counts)}`)
  if (backgroundHint) parts.push(backgroundHint)
  return parts.join('. ')
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
  const changes = useChatChangedFiles(cwd, toolCalls, turnActive)
  const { subagents, backgroundRunning, statuses, counts } = useCurrentTurnSubagents(
    toolCalls,
    messages,
    turnActive
  )
  const waiting = useBackgroundWait(sessionId, backgroundRunning, turnActive)
  const waitingLabel = waiting > 0 ? `Waiting on ${plural(waiting, 'background subagent')}` : null
  const background = useBackgroundCommands(sessionId)
  const commands = background.commands
  const rowCount: Record<StatusKind, number> = {
    subagents: subagents.length,
    background: commands.length,
    changes: changes.files.length
  }
  const shown =
    !hidden && (rowCount.subagents > 0 || rowCount.background > 0 || rowCount.changes > 0)
  const { base, close } = useOpenChip(rowCount, shown && isVisible, isMobile)

  const liveText = shown ? liveStatus(subagents.length, waitingLabel, counts, background.hint) : ''

  return (
    <>
      <span aria-live="polite" className="sr-only">
        {liveText}
      </span>
      {shown && (
        <StatusChipRow className={className}>
          {subagents.length > 0 && (
            <SubagentsChip
              {...base('subagents')}
              subagents={subagents}
              statuses={statuses}
              counts={counts}
              waitingLabel={waitingLabel}
              onRowOpen={close}
            />
          )}
          {commands.length > 0 && (
            <BackgroundChip
              {...base('background')}
              sessionId={sessionId}
              commands={commands}
              running={background.running}
              summary={background.summary}
              hint={background.hint}
              onRowOpen={close}
            />
          )}
          {changes.files.length > 0 && (
            <ChangesChip
              {...base('changes')}
              changes={changes}
              onOpenGitChanges={onOpenGitChanges}
              onClose={close}
            />
          )}
        </StatusChipRow>
      )}
    </>
  )
}
