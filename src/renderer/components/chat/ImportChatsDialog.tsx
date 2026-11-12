import type { KeyboardEvent } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { AlertCircle, Check, Minus } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { useIsMobile } from '@/hooks/use-mobile'
import type { SessionInfo } from '@/lib/acp-api'
import { formatChatFullTime, formatChatShortTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'
import { formatImportSummary, type ImportChats, useImportChats } from './use-import-chats'

interface ImportChatsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Working copy whose agent sessions are offered. */
  cwd: string
  projectId: string
}

function sessionTitle(session: SessionInfo): string | null {
  return session.title?.trim() || null
}

type CheckState = 'off' | 'mixed' | 'on'

/** The drawn box of a checkbox; the control that owns the state carries its role. */
function CheckboxMark({ state }: { state: CheckState }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors duration-150 ease-out',
        state === 'off'
          ? 'border-foreground/30 bg-transparent'
          : 'border-transparent bg-primary-fill text-primary-foreground'
      )}
    >
      {state === 'on' && <Check size={12} strokeWidth={2.5} />}
      {state === 'mixed' && <Minus size={12} strokeWidth={2.5} />}
    </span>
  )
}

/** Where a row stands in the import run in progress. */
type RowRun = 'idle' | 'outside' | 'queued' | 'in-flight' | 'done' | 'failed'

function rowRun(chats: ImportChats, sessionId: string): RowRun {
  if (!chats.importing) return 'idle'
  if (sessionId === chats.inFlightId) return 'in-flight'
  const status = chats.rowStatus.get(sessionId)
  if (status) return status
  return chats.runIds.includes(sessionId) ? 'queued' : 'outside'
}

/** The left slot of a row: its checkbox, or the run state of its chat. */
function RowMark({ run, selected }: { run: RowRun; selected: boolean }): React.JSX.Element {
  // A fixed size-4 slot, so the title never shifts as the mark changes.
  if (run === 'in-flight')
    return (
      <span className="flex size-4 shrink-0 items-center justify-center">
        <Spinner size={14} decorative />
      </span>
    )
  if (run === 'done')
    return (
      <span className="flex size-4 shrink-0 items-center justify-center text-success">
        <Check size={14} strokeWidth={2} aria-label="Imported" />
      </span>
    )
  return <CheckboxMark state={selected ? 'on' : 'off'} />
}

function SessionOption({
  session,
  selected,
  run,
  tabbable,
  error,
  onToggle,
  onFocus,
  onKeyDown
}: {
  session: SessionInfo
  selected: boolean
  run: RowRun
  tabbable: boolean
  error: string | undefined
  onToggle: () => void
  onFocus: () => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
}): React.JSX.Element {
  const parsed = session.updatedAt ? Date.parse(session.updatedAt) : Number.NaN
  const updated = Number.isFinite(parsed) ? parsed : undefined
  const title = sessionTitle(session)
  // A titled row keeps a short time so the title has room; an untitled row
  // has only its time to tell it apart, so it shows the full one.
  const time = title ? formatChatShortTime(updated) : formatChatFullTime(updated)
  const errorId = useId()
  const disabled = run !== 'idle'
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      aria-describedby={error ? errorId : undefined}
      tabIndex={tabbable ? 0 : -1}
      data-import-option
      onClick={disabled ? undefined : onToggle}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      className={cn(
        // Grid: mark, title and time share the first line; a failure reason
        // spans the title and time columns below, so the time takes no width
        // from it and the mark stays level with the title.
        'grid min-h-9 cursor-default grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded-lg px-3 py-2 text-xs outline-hidden transition-[background-color,opacity] duration-150 ease-out pointer-coarse:min-h-11',
        // Inset so the scrolling list never clips the ring's sides.
        FOCUS_RING_CLASS,
        'ring-inset',
        error
          ? 'bg-destructive/[0.06]'
          : selected
            ? 'bg-foreground/[0.03]'
            : 'hover:bg-foreground/[0.02]',
        run === 'outside' && 'opacity-50'
      )}
    >
      <RowMark run={run} selected={selected} />
      <span
        className={cn(
          'col-start-2 truncate font-medium',
          !time && 'col-span-2',
          title ? 'text-foreground' : 'text-muted-foreground'
        )}
      >
        {title ?? 'Untitled chat'}
      </span>
      {time && (
        <span className="col-start-3 tabular-nums text-2xs text-muted-foreground">{time}</span>
      )}
      {error && (
        <span
          id={errorId}
          className="col-span-2 col-start-2 flex items-center gap-1 text-xs text-destructive"
        >
          <AlertCircle size={12} aria-hidden className="shrink-0" />
          {error}
        </span>
      )}
    </div>
  )
}

function SessionList({ chats }: { chats: ImportChats }): React.JSX.Element | null {
  const listRef = useRef<HTMLDivElement>(null)
  // Roving tab stop: Tab enters the list on the last focused row.
  const [active, setActive] = useState(0)
  if (chats.phase.kind !== 'ready') return null
  const { sessions } = chats.phase
  const tabStop = Math.min(active, sessions.length - 1)

  const onOptionKeyDown = (event: KeyboardEvent<HTMLDivElement>, sessionId: string): void => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      if (!chats.importing) chats.toggle(sessionId)
      return
    }
    const options = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[data-import-option]') ?? []
    )
    const index = options.indexOf(event.currentTarget)
    const target =
      event.key === 'ArrowDown'
        ? index + 1
        : event.key === 'ArrowUp'
          ? index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? options.length - 1
              : null
    if (target === null) return
    event.preventDefault()
    options[target]?.focus()
  }

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-multiselectable="true"
      aria-label="Chats to import"
      className="flex max-h-72 flex-col gap-0.5 overflow-y-auto p-1"
    >
      {sessions.map((session, index) => (
        <SessionOption
          key={session.sessionId}
          session={session}
          selected={chats.selected.has(session.sessionId)}
          run={rowRun(chats, session.sessionId)}
          tabbable={index === tabStop}
          error={chats.rowErrors.get(session.sessionId)}
          onToggle={() => chats.toggle(session.sessionId)}
          onFocus={() => setActive(index)}
          onKeyDown={(event) => onOptionKeyDown(event, session.sessionId)}
        />
      ))}
    </div>
  )
}

function SelectAll({
  chats,
  total,
  agentName
}: {
  chats: ImportChats
  total: number
  agentName: string
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const count = chats.selected.size
  const state: CheckState = count === 0 ? 'off' : count === total ? 'on' : 'mixed'
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = state === 'mixed'
  }, [state])
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border p-1 pr-4">
      <label
        className={cn(
          'flex min-h-8 min-w-0 cursor-default items-center gap-3 rounded-lg px-3 text-xs font-medium text-foreground pointer-coarse:min-h-11',
          'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-focus-ring',
          chats.importing && 'opacity-50'
        )}
      >
        <input
          ref={inputRef}
          type="checkbox"
          className="sr-only"
          checked={state === 'on'}
          disabled={chats.importing}
          onChange={state === 'on' ? chats.clearSelection : chats.selectAll}
        />
        <CheckboxMark state={state} />
        <span className="truncate">All {agentName} chats</span>
      </label>
      <span className="shrink-0 tabular-nums text-2xs text-muted-foreground">
        {total} in this folder
      </span>
    </div>
  )
}

function Body({ chats, agentName }: { chats: ImportChats; agentName: string }): React.JSX.Element {
  const { phase } = chats
  if (phase.kind === 'loading') {
    return (
      <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground" role="status">
        <Spinner size={14} decorative />
        Looking for chats…
      </div>
    )
  }
  if (phase.kind === 'unsupported') {
    return (
      <p className="py-4 text-xs text-muted-foreground">
        This agent cannot list and load its chats, so there is nothing to import.
      </p>
    )
  }
  if (phase.kind === 'unavailable') {
    return (
      <p className="py-4 text-xs text-muted-foreground">
        The agent could not start. Check its configuration and try again.
      </p>
    )
  }
  if (phase.kind === 'error') {
    return (
      <div className="flex flex-col items-start gap-2 py-4 text-xs">
        <p role="alert" className="text-destructive">
          {phase.message}
        </p>
        <Button variant="outline" size="xs" onClick={chats.retry}>
          Try again
        </Button>
      </div>
    )
  }
  if (phase.sessions.length === 0) {
    return (
      <p className="py-4 text-xs text-muted-foreground">
        No chats to import. Every chat the agent keeps for this folder is already in your history.
      </p>
    )
  }
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border">
      <SelectAll chats={chats} total={phase.sessions.length} agentName={agentName} />
      <SessionList chats={chats} />
    </div>
  )
}

function footerStatus(chats: ImportChats, count: number): string | null {
  if (chats.stopping) return 'Stopping after this chat…'
  if (chats.importing) {
    // The chat in flight is the one counted: the first reads "1 of N".
    const total = chats.runIds.length
    return `Importing ${Math.min(chats.progress + 1, total)} of ${total}…`
  }
  if (chats.summary) return formatImportSummary(chats.summary)
  if (chats.phase.kind === 'ready' && chats.phase.sessions.length > 0) return `${count} selected`
  return null
}

function importLabel(count: number): string {
  if (count === 1) return 'Import 1 chat'
  if (count > 1) return `Import ${count} chats`
  return 'Import'
}

/**
 * "Import chats": copies chats an agent keeps outside Troupe (for example
 * Claude Code CLI chats) into the chat history of the active working copy.
 * The user picks one, several or all; an imported chat opens and continues
 * like any other chat.
 */
export function ImportChatsDialog({
  open,
  onOpenChange,
  cwd,
  projectId
}: ImportChatsDialogProps): React.JSX.Element {
  const chats = useImportChats({ open, cwd, projectId, onDone: () => onOpenChange(false) })
  const agentSelectId = useId()
  const { phase, selected, importing, stopping, summary } = chats
  const count = selected.size
  const configName = chats.configs.find((c) => c.id === chats.configId)?.name
  const agentName = configName ?? 'the agent'
  const isMobile = useIsMobile()
  const buttonSize = isMobile ? 'touch' : 'sm'
  const buttonClass = isMobile ? 'flex-1' : undefined

  // While importing, every way out of the dialog (Esc, outside click, the
  // close button) stops the run instead of hiding it.
  const onDialogOpenChange = (next: boolean): void => {
    if (!next && importing) {
      chats.requestStop()
      return
    }
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={onDialogOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {configName ? `Import chats from ${configName}` : 'Import chats'}
          </DialogTitle>
          <DialogDescription>
            Bring in chats from {agentName} sessions you ran outside Troupe. You can continue them
            here afterwards.
          </DialogDescription>
        </DialogHeader>

        {chats.configs.length > 1 && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={agentSelectId} className="text-xs">
              Agent
            </Label>
            <Select
              value={chats.configId ?? undefined}
              onValueChange={chats.setConfigId}
              disabled={importing}
            >
              <SelectTrigger id={agentSelectId} className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {chats.configs.map((config) => (
                  <SelectItem key={config.id} value={config.id}>
                    {config.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {chats.configId === null ? (
          <p className="py-4 text-xs text-muted-foreground">
            Configure an agent first. Import reads the chats of a configured agent.
          </p>
        ) : (
          <Body chats={chats} agentName={agentName} />
        )}

        <DialogFooter className="flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between sm:space-x-0">
          <p
            role="status"
            className="flex min-w-0 items-center gap-2 text-xs tabular-nums text-muted-foreground"
          >
            {importing && <Spinner size={12} decorative />}
            {footerStatus(chats, count)}
          </p>
          <div className="flex items-center gap-2 sm:shrink-0">
            {importing ? (
              <Button
                variant="outline"
                size={buttonSize}
                className={buttonClass}
                disabled={stopping}
                onClick={chats.requestStop}
              >
                {stopping ? 'Stopping…' : 'Stop import'}
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  size={buttonSize}
                  className={buttonClass}
                  onClick={() => onOpenChange(false)}
                >
                  {summary ? 'Close' : 'Cancel'}
                </Button>
                <Button
                  size={buttonSize}
                  className={buttonClass}
                  disabled={phase.kind !== 'ready' || count === 0}
                  onClick={() => void chats.importSelected()}
                >
                  {summary && summary.failed > 0 && count > 0 ? 'Try again' : importLabel(count)}
                </Button>
              </>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
