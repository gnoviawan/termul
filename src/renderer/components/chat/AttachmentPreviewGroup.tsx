import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  Attachment,
  AttachmentHoverCard,
  AttachmentHoverCardContent,
  AttachmentHoverCardTrigger,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments
} from '@/components/ai-elements/attachments'
import { cn } from '@/lib/utils'
import {
  attachmentAriaLabel,
  type PendingAttachment,
  pendingToAttachmentData
} from './chat-attachments'

interface AttachmentPreviewGroupProps {
  attachments: PendingAttachment[]
  onRemove: (id: string) => void
  className?: string
}

/** Staged-attachment badges shown in a composer above the textarea. */
export function AttachmentPreviewGroup({
  attachments,
  onRemove,
  className
}: AttachmentPreviewGroupProps): React.JSX.Element | null {
  const reduced = useReducedMotion() ?? false

  if (attachments.length === 0) return null
  return (
    <Attachments variant="inline" className={cn('overflow-y-visible px-3 pb-1 pt-3', className)}>
      <AnimatePresence initial={false}>
        {attachments.map((a) => {
          const data = pendingToAttachmentData(a)
          const ariaLabel = attachmentAriaLabel(a.name)
          const previewUrl = a.kind === 'file-embed' ? undefined : a.previewUrl
          const hasImagePreview = Boolean(previewUrl)
          // Images preview inline via a hover card; non-image files render as a
          // static badge. Nothing opens a backing path — temp/file paths can
          // live in sandboxed dirs the OS opener refuses, which would surface as
          // an error toast, so clicks are intentionally disabled.
          return (
            <motion.div
              key={a.id}
              className="shrink-0 snap-start"
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
              animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
            >
              <Attachment data={data} title={a.name} onRemove={() => onRemove(a.id)}>
                {hasImagePreview ? (
                  <AttachmentHoverCard>
                    <AttachmentHoverCardTrigger asChild>
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-1.5"
                        aria-label={ariaLabel}
                      >
                        <AttachmentPreview />
                        <AttachmentInfo />
                      </button>
                    </AttachmentHoverCardTrigger>
                    <AttachmentHoverCardContent>
                      <img
                        src={previewUrl}
                        alt={ariaLabel}
                        className="h-32 w-auto rounded object-cover"
                      />
                    </AttachmentHoverCardContent>
                  </AttachmentHoverCard>
                ) : (
                  <>
                    <AttachmentPreview />
                    <AttachmentInfo />
                  </>
                )}
                <AttachmentRemove label={`Remove ${ariaLabel}`} />
              </Attachment>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </Attachments>
  )
}
