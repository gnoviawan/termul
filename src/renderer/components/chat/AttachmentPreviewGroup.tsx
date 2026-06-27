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
import { ImageLightbox } from '@/components/ui/image-lightbox'
import { cn } from '@/lib/utils'
import type { PendingAttachment } from './chat-attachments'

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
  if (attachments.length === 0) return null
  return (
    <AttachmentGroup className={cn('px-3 pt-3', className)}>
      {attachments.map((a) => {
        const previewUrl = attachmentPreviewUrl(a)
        return (
          <Attachment
            key={a.id}
            orientation={previewUrl ? 'vertical' : 'horizontal'}
            size="sm"
            className={previewUrl ? 'w-28' : 'w-52'}
          >
            {previewUrl ? (
              <AttachmentMedia variant="image">
                <ImageLightbox src={previewUrl} alt={a.name}>
                  <img src={previewUrl} alt={a.name} className="cursor-zoom-in" />
                </ImageLightbox>
              </AttachmentMedia>
            ) : (
              <AttachmentMedia variant="icon">
                <FileText />
              </AttachmentMedia>
            )}
            <AttachmentContent>
              <AttachmentTitle>{a.name}</AttachmentTitle>
              {!previewUrl && a.kind !== 'image' && (
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
        )
      })}
    </AttachmentGroup>
  )
}
