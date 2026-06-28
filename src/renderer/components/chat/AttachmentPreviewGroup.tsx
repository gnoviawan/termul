import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { FileText, X } from 'lucide-react'
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle
} from '@/components/ui/attachment'
import { cn } from '@/lib/utils'
import { attachmentAriaLabel, type PendingAttachment } from './chat-attachments'
import { ImageAttachmentChip } from './ImageAttachmentChip'

/** Data-URL thumbnail for an attachment, when it is an image. */
function attachmentPreviewUrl(a: PendingAttachment): string | undefined {
  if (a.kind === 'image') return a.previewUrl
  if (a.kind === 'file-ref') return a.previewUrl
  return undefined
}

interface AttachmentPreviewGroupProps {
  attachments: PendingAttachment[]
  onRemove: (id: string) => void
  className?: string
}

/** Staged-attachment chips shown in a composer above the textarea. */
export function AttachmentPreviewGroup({
  attachments,
  onRemove,
  className
}: AttachmentPreviewGroupProps): React.JSX.Element | null {
  const reduced = useReducedMotion() ?? false

  if (attachments.length === 0) return null
  return (
    <AttachmentGroup className={cn('overflow-y-visible px-3 pb-1 pt-3', className)}>
      <AnimatePresence initial={false}>
        {attachments.map((a) => {
          const previewUrl = attachmentPreviewUrl(a)
          const label = attachmentAriaLabel(a.name)

          if (previewUrl) {
            return (
              <motion.div
                key={a.id}
                className="shrink-0 snap-start p-0.5"
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
                animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
                exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
              >
                <ImageAttachmentChip
                  src={previewUrl}
                  alt={label}
                  size="composer"
                  onRemove={() => onRemove(a.id)}
                />
              </motion.div>
            )
          }

          return (
            <motion.div
              key={a.id}
              className="w-52 shrink-0 snap-start"
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
              animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
            >
              <Attachment orientation="horizontal" size="sm" className="w-full">
                <AttachmentMedia variant="icon">
                  <FileText />
                </AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle>{a.name}</AttachmentTitle>
                  {a.kind !== 'image' && (
                    <AttachmentDescription>
                      {a.kind === 'file-ref' ? 'Linked file' : 'Embedded text'}
                    </AttachmentDescription>
                  )}
                </AttachmentContent>
                <AttachmentActions>
                  <AttachmentAction aria-label={`Remove ${label}`} onClick={() => onRemove(a.id)}>
                    <X />
                  </AttachmentAction>
                </AttachmentActions>
              </Attachment>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </AttachmentGroup>
  )
}
