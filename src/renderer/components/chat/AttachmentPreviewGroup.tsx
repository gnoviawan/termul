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
import type { PendingAttachment } from './chat-attachments'

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
  if (attachments.length === 0) return null
  return (
    <AttachmentGroup className={cn('px-3 pt-3', className)}>
      {attachments.map((a) => (
        <Attachment
          key={a.id}
          orientation={a.kind === 'image' ? 'vertical' : 'horizontal'}
          size="sm"
          className={a.kind === 'image' ? 'w-28' : 'w-52'}
        >
          {a.kind === 'image' ? (
            <AttachmentMedia variant="image">
              <img src={a.previewUrl} alt={a.name} />
            </AttachmentMedia>
          ) : (
            <AttachmentMedia variant="icon">
              <FileText />
            </AttachmentMedia>
          )}
          <AttachmentContent>
            <AttachmentTitle>{a.name}</AttachmentTitle>
            {a.kind !== 'image' && (
              <AttachmentDescription>
                {a.kind === 'file-ref' ? 'Linked file' : 'Embedded text'}
              </AttachmentDescription>
            )}
          </AttachmentContent>
          <AttachmentActions>
            <AttachmentAction aria-label={`Remove ${a.name}`} onClick={() => onRemove(a.id)}>
              <X />
            </AttachmentAction>
          </AttachmentActions>
        </Attachment>
      ))}
    </AttachmentGroup>
  )
}
