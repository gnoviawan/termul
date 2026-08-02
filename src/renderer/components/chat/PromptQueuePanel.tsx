import { ArrowUp, Trash2 } from 'lucide-react'
import { memo, useCallback } from 'react'
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
import type { QueuedPrompt } from '@/stores/acp-store'
import { previewQueuedPrompt } from './prompt-queue-utils'

interface PromptQueuePanelProps {
  items: QueuedPrompt[]
  onRemove: (queueId: string) => void
  onSendNow: (queueId: string) => void
}

interface QueueMessageActionsProps {
  queueId: string
  onRemove: (id: string) => void
  onSendNow: (id: string) => void
}

const QueueMessageActions = memo(({ queueId, onRemove, onSendNow }: QueueMessageActionsProps) => {
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

  return (
    <QueueItemActions>
      <QueueItemAction
        aria-label="Remove from queue"
        title="Remove from queue"
        onClick={handleRemove}
      >
        <Trash2 size={12} />
      </QueueItemAction>
      <QueueItemAction aria-label="Send now" title="Send now" onClick={handleSendNow}>
        <ArrowUp size={14} />
      </QueueItemAction>
    </QueueItemActions>
  )
})
QueueMessageActions.displayName = 'QueueMessageActions'

/** Collapsible pending-prompt queue above the composer (AI Elements Queue pattern). */
export function PromptQueuePanel({
  items,
  onRemove,
  onSendNow
}: PromptQueuePanelProps): React.JSX.Element | null {
  if (items.length === 0) return null

  return (
    <Queue className="mb-2">
      <QueueSection defaultOpen>
        <QueueSectionTrigger>
          <QueueSectionLabel count={items.length} label="Queued" className="tabular-nums" />
        </QueueSectionTrigger>
        <QueueSectionContent>
          <QueueList>
            {items.map((item) => {
              // Preview the display (token) blocks so the queue reads as the
              // user's typed text + chips, not the path-framed wire payload.
              const preview = previewQueuedPrompt(item.displayBlocks ?? item.blocks)
              const summary = preview.text || preview.attachments[0]?.filename || '(queued message)'
              const hasAttachments = preview.attachments.length > 0

              return (
                <QueueItem key={item.id} className="px-0 py-0.5 hover:bg-transparent">
                  <div className="ml-1 mr-0.5 flex items-center gap-2 rounded-md px-2.5 py-1.5 transition-colors hover:bg-muted">
                    <QueueItemContent title={summary}>{summary}</QueueItemContent>
                    <QueueMessageActions
                      queueId={item.id}
                      onRemove={onRemove}
                      onSendNow={onSendNow}
                    />
                  </div>
                  {hasAttachments && (
                    <QueueItemAttachment>
                      {preview.attachments.map((attachment) =>
                        attachment.isImage && attachment.url ? (
                          <QueueItemImage
                            key={attachment.id}
                            src={attachment.url}
                            alt={attachment.filename}
                            className="outline outline-1 outline-white/10"
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
        </QueueSectionContent>
      </QueueSection>
    </Queue>
  )
}
