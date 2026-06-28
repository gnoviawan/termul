import { motion, useReducedMotion } from 'framer-motion'
import { X } from 'lucide-react'
import { ImageLightbox } from '@/components/ui/image-lightbox'
import { cn } from '@/lib/utils'
import { staggerChild } from './chat-motion'

const SIZE_PX = { composer: 56, message: 72 } as const

export type ImageAttachmentChipSize = keyof typeof SIZE_PX

interface ImageAttachmentChipProps {
  src: string
  alt: string
  size?: ImageAttachmentChipSize
  /** Overlay remove control — composer only. */
  onRemove?: () => void
  /** Subtle enter on mount (composer attachments). */
  animateEnter?: boolean
  /** Pulse placeholder while the image bytes load. */
  loading?: boolean
  className?: string
}

/**
 * Compact thumbnail-only image attachment — shared by the composer preview and
 * sent-message bubbles.
 */
export function ImageAttachmentChip({
  src,
  alt,
  size = 'composer',
  onRemove,
  animateEnter = false,
  loading = false,
  className
}: ImageAttachmentChipProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const px = SIZE_PX[size]
  const enter = staggerChild(0, reduced, 'neutral')

  const chip = (
    <div
      className={cn(
        'relative shrink-0 rounded-xl p-1 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.45),0_1px_2px_hsl(var(--foreground)/0.04)]',
        className
      )}
      style={{ width: px + 8, height: px + 8 }}
    >
      <div
        className="relative size-full overflow-hidden rounded-lg bg-muted shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]"
        style={{ width: px, height: px }}
      >
        {loading ? (
          <div className="size-full animate-pulse bg-muted" aria-hidden="true" />
        ) : (
          <ImageLightbox src={src} alt={alt}>
            <img src={src} alt={alt} className="size-full cursor-zoom-in object-cover" />
          </ImageLightbox>
        )}
      </div>
      {onRemove && (
        <button
          type="button"
          data-press-feedback="off"
          aria-label={`Remove ${alt}`}
          title={`Remove ${alt}`}
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="absolute right-0.5 top-0.5 flex size-7 items-center justify-center rounded-full bg-background/95 text-muted-foreground shadow-sm ring-1 ring-border/60 transition-colors before:absolute before:-inset-1.5 before:content-[''] hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  )

  if (!animateEnter) return chip

  return (
    <motion.div
      initial={enter.initial}
      animate={enter.animate}
      transition={enter.transition}
      className="shrink-0"
    >
      {chip}
    </motion.div>
  )
}
