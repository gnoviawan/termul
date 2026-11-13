import { memo, useCallback, useRef, useState } from 'react'
import { QueueItemFile, QueueItemImage } from '@/components/ai-elements/queue'
import { ChevronDown, Edit2, GripVertical, Trash2, X } from '@/components/icons'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { cn } from '@/lib/utils'
import type { QueuedPrompt } from '@/stores/acp-store'
import { previewQueuedPrompt } from './prompt-queue-utils'

interface PromptQueuePanelProps {
  items: QueuedPrompt[]
  onRemove: (queueId: string) => void
  /** Steer: stop the running turn and send this prompt now. */
  onSendNow: (queueId: string) => void
  /** Move a prompt to `toIndex`. Without it the rows have no drag handle. */
  onMove?: (queueId: string, toIndex: number) => void
  /** Drop every queued prompt. Without it the header has no clear action. */
  onClear?: () => void
  /** Take a text-only prompt out of the queue into the composer. */
  onEdit?: (item: QueuedPrompt, text: string) => void
  /** Whether the queue starts expanded. Seeds local state at mount; defaults to true. */
  defaultOpen?: boolean
}

/** 22px icon action; a 44px hit area on touch. */
const ICON_ACTION_CLASS = cn(
  'relative flex size-[22px] shrink-0 items-center justify-center rounded-md text-muted-foreground',
  'transition-colors duration-150 ease-out hover:bg-foreground/[0.08] hover:text-foreground motion-reduce:transition-none',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
  "after:absolute after:-inset-[3px] after:content-[''] pointer-coarse:after:-inset-[11px]"
)

/** Hidden at rest on a fine pointer; shown on row hover or focus, always on touch. */
const ON_ROW_HOVER =
  'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 pointer-coarse:opacity-100'

function QueueAction({
  label,
  hint,
  onClick,
  className,
  children
}: {
  label: string
  hint: string
  onClick: () => void
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={(event) => {
            event.stopPropagation()
            onClick()
          }}
          className={className ?? ICON_ACTION_CLASS}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{hint}</TooltipContent>
    </Tooltip>
  )
}

/** The text a text-only prompt was typed with, or null when it holds files. */
function editableText(item: QueuedPrompt): string | null {
  const blocks = item.displayBlocks ?? item.blocks
  if (blocks.length === 0 || blocks.some((block) => block.type !== 'text')) return null
  return blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

interface QueueRowProps {
  item: QueuedPrompt
  index: number
  count: number
  dragging: boolean
  onRemove: (queueId: string) => void
  onSendNow: (queueId: string) => void
  onEdit?: (item: QueuedPrompt, text: string) => void
  onMove?: (queueId: string, toIndex: number) => void
  onHandlePointerDown?: (event: React.PointerEvent, queueId: string) => void
  /** Name each action after its row (phone: actions always show). */
  namedActions: boolean
}

const QueueRow = memo(function QueueRow({
  item,
  index,
  count,
  dragging,
  onRemove,
  onSendNow,
  onEdit,
  onMove,
  onHandlePointerDown,
  namedActions
}: QueueRowProps): React.JSX.Element {
  // Preview the display (token) blocks so the queue reads as the user's typed
  // text + chips, not the path-framed wire payload.
  const preview = previewQueuedPrompt(item.displayBlocks ?? item.blocks)
  const summary = preview.text || preview.attachments[0]?.filename || '(queued message)'
  const text = onEdit ? editableText(item) : null
  const named = (verb: string) => (namedActions ? `${verb}: ${summary}` : verb)

  return (
    <li
      data-queue-row={item.id}
      className={cn(
        'group/row flex flex-col rounded-lg transition-colors duration-150 ease-out hover:bg-foreground/[0.06] focus-within:bg-foreground/[0.06] motion-reduce:transition-none',
        dragging && 'bg-foreground/[0.06]'
      )}
    >
      <div className="flex min-h-7 items-center gap-1.5 pl-2 pr-[3px] pointer-coarse:min-h-11">
        {onMove && count > 1 ? (
          <button
            type="button"
            aria-label={`Reorder: ${summary}`}
            aria-description="Drag, or press the up and down arrow keys"
            onPointerDown={(event) => onHandlePointerDown?.(event, item.id)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
              event.preventDefault()
              onMove(item.id, index + (event.key === 'ArrowUp' ? -1 : 1))
            }}
            className={cn(
              'relative flex size-4 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-muted-foreground transition-opacity duration-150 ease-out active:cursor-grabbing motion-reduce:transition-none',
              'focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
              "after:absolute after:-inset-1.5 after:content-[''] pointer-coarse:after:-inset-3.5",
              dragging ? 'opacity-100' : ON_ROW_HOVER
            )}
          >
            <GripVertical size={14} aria-hidden="true" />
          </button>
        ) : (
          <span aria-hidden="true" className="size-4 shrink-0" />
        )}
        <span
          title={summary}
          className="min-w-0 flex-1 truncate text-[13px] leading-5 text-muted-foreground group-hover/row:text-foreground group-focus-within/row:text-foreground"
        >
          {summary}
        </span>
        <span className={cn('flex shrink-0 items-center gap-0.5', ON_ROW_HOVER)}>
          <QueueAction
            label={named('Steer')}
            hint="Stop the turn and send this now"
            onClick={() => onSendNow(item.id)}
            className="relative inline-flex h-[22px] shrink-0 items-center rounded-md border-[0.5px] border-field-border/40 bg-muted px-2 text-xs font-medium text-foreground shadow-xs transition-colors duration-150 ease-out hover:bg-[color-mix(in_oklab,oklch(var(--muted)),oklch(var(--foreground))_4%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring motion-reduce:transition-none after:absolute after:-inset-y-[3px] after:inset-x-0 after:content-[''] pointer-coarse:after:-inset-y-[11px]"
          >
            Steer
          </QueueAction>
          {text !== null && onEdit && (
            <QueueAction label={named('Edit')} hint="Edit" onClick={() => onEdit(item, text)}>
              <Edit2 size={14} aria-hidden="true" />
            </QueueAction>
          )}
          <QueueAction
            label={named('Remove from queue')}
            hint="Remove"
            onClick={() => onRemove(item.id)}
          >
            <Trash2 size={14} aria-hidden="true" />
          </QueueAction>
        </span>
      </div>
      {preview.attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pb-1.5 pl-[30px] pr-2">
          {preview.attachments.map((attachment) =>
            attachment.isImage && attachment.url ? (
              <QueueItemImage
                key={attachment.id}
                src={attachment.url}
                alt={attachment.filename}
                className="outline outline-1 -outline-offset-1 outline-foreground/10"
              />
            ) : (
              <QueueItemFile key={attachment.id} className="text-2xs">
                {attachment.filename}
              </QueueItemFile>
            )
          )}
        </div>
      )}
    </li>
  )
})

/**
 * Queued prompts, docked at the top of the composer card: a header with the
 * count (it collapses the list) and Clear, then one row per prompt with a
 * drag handle, Steer, Edit and Remove. The queue sends top to bottom.
 */
export function PromptQueuePanel({
  items,
  onRemove,
  onSendNow,
  onMove,
  onClear,
  onEdit,
  defaultOpen = true
}: PromptQueuePanelProps): React.JSX.Element | null {
  const [open, setOpen] = useState(defaultOpen)
  const [dragId, setDragId] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const isMobileShell = useMobileWebShell()
  const listRef = useRef<HTMLOListElement>(null)
  const count = items.length

  // Stable across renders, so the memoized rows do not re-render on each one.
  const move = useCallback(
    (queueId: string, toIndex: number) => {
      if (!onMove || toIndex < 0 || toIndex >= count) return
      onMove(queueId, toIndex)
      setAnnouncement(`Moved to place ${toIndex + 1} of ${count}`)
    },
    [onMove, count]
  )

  // Pointer drag on the handle: the row takes the slot under the pointer as
  // it passes each row's middle. No motion while dragging.
  const startDrag = useCallback(
    (event: React.PointerEvent, queueId: string) => {
      if (event.button !== 0) return
      event.preventDefault()
      const handle = event.currentTarget as HTMLElement
      handle.setPointerCapture(event.pointerId)
      setDragId(queueId)
      const onPointerMove = (moveEvent: PointerEvent) => {
        const rows = Array.from(listRef.current?.querySelectorAll('[data-queue-row]') ?? [])
        const from = rows.findIndex((row) => row.getAttribute('data-queue-row') === queueId)
        if (from === -1) return
        let slot = rows.findIndex((row) => {
          const box = row.getBoundingClientRect()
          return moveEvent.clientY < box.top + box.height / 2
        })
        if (slot === -1) slot = rows.length
        const to = slot > from ? slot - 1 : slot
        if (to !== from) move(queueId, to)
      }
      const onPointerEnd = () => {
        handle.removeEventListener('pointermove', onPointerMove)
        handle.removeEventListener('pointerup', onPointerEnd)
        handle.removeEventListener('pointercancel', onPointerEnd)
        setDragId(null)
      }
      handle.addEventListener('pointermove', onPointerMove)
      handle.addEventListener('pointerup', onPointerEnd)
      handle.addEventListener('pointercancel', onPointerEnd)
    },
    [move]
  )

  if (count === 0) return null
  const countLabel = `${count} queued`

  return (
    <section
      aria-label="Queued messages"
      data-testid="prompt-queue"
      className="flex flex-col gap-0.5 border-b-[0.5px] border-border p-1.5"
    >
      <div className="flex min-h-7 items-center gap-1.5 pr-[3px]">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 self-stretch rounded-md pl-2 text-left text-xs font-medium tabular-nums text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground motion-reduce:transition-none',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring',
            isMobileShell && 'min-h-11'
          )}
        >
          <span className="flex size-4 shrink-0 items-center justify-center">
            <ChevronDown
              size={14}
              aria-hidden="true"
              className={cn(
                'transition-transform duration-150 ease-out motion-reduce:transition-none',
                !open && '-rotate-90'
              )}
            />
          </span>
          {countLabel}
        </button>
        {onClear && (
          <QueueAction label="Clear queue" hint="Clear queue" onClick={onClear}>
            <X size={14} aria-hidden="true" />
          </QueueAction>
        )}
      </div>
      <CollapseExpandMotion open={open} motion="chat">
        <ol ref={listRef} className="flex flex-col gap-0.5">
          {items.map((item, index) => (
            <QueueRow
              key={item.id}
              item={item}
              index={index}
              count={items.length}
              dragging={dragId === item.id}
              onRemove={onRemove}
              onSendNow={onSendNow}
              onEdit={onEdit}
              onMove={onMove ? move : undefined}
              onHandlePointerDown={startDrag}
              namedActions={isMobileShell}
            />
          ))}
        </ol>
      </CollapseExpandMotion>
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </section>
  )
}
