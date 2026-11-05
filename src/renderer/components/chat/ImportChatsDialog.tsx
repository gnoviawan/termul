import type { KeyboardEvent } from 'react'
import { useId, useRef } from 'react'
import { Check } from '@/components/icons'
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
import type { SessionInfo } from '@/lib/acp-api'
import { formatChatCreatedTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'
import { type ImportChats, useImportChats } from './use-import-chats'

interface ImportChatsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Working copy whose agent sessions are offered. */
  cwd: string
  projectId: string
}

function sessionTitle(session: SessionInfo): string {
  return session.title?.trim() || 'Untitled chat'
}

function SessionOption({
  session,
  selected,
  disabled,
  tabbable,
  onToggle,
  onKeyDown
}: {
  session: SessionInfo
  selected: boolean
  disabled: boolean
  tabbable: boolean
  onToggle: () => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
}): React.JSX.Element {
  const updated = session.updatedAt ? Date.parse(session.updatedAt) : Number.NaN
  const time = formatChatCreatedTime(Number.isFinite(updated) ? updated : undefined)
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      tabIndex={tabbable ? 0 : -1}
      data-import-option
      onClick={disabled ? undefined : onToggle}
      onKeyDown={onKeyDown}
      className={cn(
        'flex min-h-9 cursor-default items-center gap-3 rounded-lg px-3 py-2 text-xs outline-hidden transition-colors duration-150 ease-out pointer-coarse:min-h-11',
        FOCUS_RING_CLASS,
        selected
          ? 'bg-foreground/[0.03] ring-1 ring-inset ring-foreground/[0.12]'
          : 'hover:bg-foreground/[0.02]',
        disabled && 'opacity-60'
      )}
    >
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
        {sessionTitle(session)}
      </span>
      {time && <span className="shrink-0 tabular-nums text-2xs text-muted-foreground">{time}</span>}
      <span className="flex size-4 shrink-0 justify-center text-foreground">
        {selected && <Check size={15} />}
      </span>
    </div>
  )
}

function SessionList({ chats }: { chats: ImportChats }): React.JSX.Element | null {
  const listRef = useRef<HTMLDivElement>(null)
  if (chats.phase.kind !== 'ready') return null
  const { sessions } = chats.phase

  const onOptionKeyDown = (event: KeyboardEvent<HTMLDivElement>, sessionId: string): void => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      if (!chats.importing) chats.toggle(sessionId)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const options = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[data-import-option]') ?? []
    )
    const index = options.indexOf(event.currentTarget)
    options[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus()
  }

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-multiselectable="true"
      aria-label="Chats to import"
      className="flex max-h-72 flex-col gap-0.5 overflow-y-auto"
    >
      {sessions.map((session, index) => (
        <SessionOption
          key={session.sessionId}
          session={session}
          selected={chats.selected.has(session.sessionId)}
          disabled={chats.importing}
          tabbable={index === 0}
          onToggle={() => chats.toggle(session.sessionId)}
          onKeyDown={(event) => onOptionKeyDown(event, session.sessionId)}
        />
      ))}
    </div>
  )
}

function Body({ chats }: { chats: ImportChats }): React.JSX.Element {
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
  const all = chats.selected.size === phase.sessions.length
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="tabular-nums">
          {chats.selected.size} of {phase.sessions.length} selected
        </span>
        <Button
          variant="link"
          size="xs"
          disabled={chats.importing}
          onClick={all ? chats.clearSelection : chats.selectAll}
        >
          {all ? 'Clear selection' : 'Select all'}
        </Button>
      </div>
      <SessionList chats={chats} />
    </div>
  )
}

/**
 * "Import chats": copies chats an agent keeps outside Termul (for example
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
  const { phase, selected, importing, progress } = chats
  const count = selected.size

  return (
    <Dialog open={open} onOpenChange={(next) => (importing ? undefined : onOpenChange(next))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import chats</DialogTitle>
          <DialogDescription>
            Bring chats you had with the agent outside Termul into your history. You can continue
            them afterwards.
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
          <Body chats={chats} />
        )}

        {chats.failure && (
          <p role="alert" className="text-xs text-destructive">
            {chats.failure}
          </p>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            size="sm"
            disabled={importing}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={importing || phase.kind !== 'ready' || count === 0}
            onClick={() => void chats.importSelected()}
          >
            {importing
              ? `Importing ${progress} of ${count}…`
              : count === 1
                ? 'Import 1 chat'
                : count > 1
                  ? `Import ${count} chats`
                  : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
