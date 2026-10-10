import { memo, useCallback, useState } from 'react'
import {
  Queue,
  QueueItem,
  QueueItemAction,
  QueueItemActions,
  QueueItemAttachment,
  QueueItemContent,
  QueueItemFile,
  QueueItemImage,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger
} from '@/components/ai-elements/queue'
import { ArrowUp, Trash2 } from '@/components/icons'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import type { QueuedPrompt } from '@/stores/acp-store'
import { previewQueuedPrompt } from './prompt-queue-utils'

interface PromptQueuePanelProps {
  items: QueuedPrompt[]
  onRemove: (queueId: string) => void
  onSendNow: (queueId: string) => void
  /** Whether the queue starts expanded. Seeds local state at mount; defaults to true. */
  defaultOpen?: boolean
}

interface QueueMessageActionsProps {
  queueId: string
  onRemove: (id: string) => void
  onSendNow: (id: string) => void
  /** When set (mobile), the actions name their row: "Send now: {summary}". */
  summary?: string
}

const QueueMessageActions = memo(
  ({ queueId, onRemove, onSendNow, summary }: QueueMessageActionsProps) => {
    const handleRemove = useCallback(
      (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        onRemove(queueId)
      },
      [onRemove, queueId]
    )
    const handleSendNow = useCallback(
      (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        onSendNow(queueId)
      },
      [onSendNow, queueId]
    )
    const sendNowLabel = summary ? `Send now: ${summary}` : 'Send now'
    const removeLabel = summary ? `Remove from queue: ${summary}` : 'Remove from queue'

    return (
      <QueueItemActions className="items-center gap-1">
        <QueueItemAction
          aria-label={sendNowLabel}
          title={sendNowLabel}
          onClick={handleSendNow}
          className="text-foreground hover:bg-foreground/10"
        >
          <ArrowUp size={13} />
        </QueueItemAction>
        <QueueItemAction
          aria-label={removeLabel}
          title={removeLabel}
          onClick={handleRemove}
          className="text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 size={11} />
        </QueueItemAction>
      </QueueItemActions>
    )
  }
)
QueueMessageActions.displayName = 'QueueMessageActions'

/** Collapsible pending-prompt queue above the composer (AI Elements Queue pattern). */
export function PromptQueuePanel({
  items,
  onRemove,
  onSendNow,
  defaultOpen = true
}: PromptQueuePanelProps): React.JSX.Element | null {
  const [open, setOpen] = useState(defaultOpen)
  const isMobileShell = useMobileWebShell()
  if (items.length === 0) return null

  return (
    <Queue className="mb-2">
      <QueueSection open={open} onOpenChange={setOpen}>
        <QueueSectionTrigger className={isMobileShell ? 'min-h-11' : undefined}>
          <QueueSectionLabel count={items.length} label="Queued" className="tabular-nums" />
        </QueueSectionTrigger>
        <QueueSectionContent forceMount>
          <CollapseExpandMotion open={open}>
            <QueueList>
              {items.map((item) => {
                // Preview the display (token) blocks so the queue reads as the
                // user's typed text + chips, not the path-framed wire payload.
                const preview = previewQueuedPrompt(item.displayBlocks ?? item.blocks)
                const summary =
                  preview.text || preview.attachments[0]?.filename || '(queued message)'
                const hasAttachments = preview.attachments.length > 0

                return (
                  <QueueItem key={item.id}>
                    <div className="flex items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-muted">
                      <QueueItemContent title={summary}>{summary}</QueueItemContent>
                      <QueueMessageActions
                        queueId={item.id}
                        onRemove={onRemove}
                        onSendNow={onSendNow}
                        summary={isMobileShell ? summary : undefined}
                      />
                    </div>
                    {hasAttachments && (
                      <QueueItemAttachment className="px-2">
                        {preview.attachments.map((attachment) =>
                          attachment.isImage && attachment.url ? (
                            <QueueItemImage
                              key={attachment.id}
                              src={attachment.url}
                              alt={attachment.filename}
                              className="outline outline-1 -outline-offset-1 outline-foreground/10"
                            />
                          ) : (
                            <QueueItemFile key={attachment.id}>{attachment.filename}</QueueItemFile>
                          )
                        )}
                      </QueueItemAttachment>
                    )}
                  </QueueItem>
                )
              })}
            </QueueList>
          </CollapseExpandMotion>
        </QueueSectionContent>
      </QueueSection>
    </Queue>
  )
}
