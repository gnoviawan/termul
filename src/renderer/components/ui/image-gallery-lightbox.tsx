import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Download, X } from '@/components/icons'
import { NativeWebviewOccluder } from '@/hooks/use-native-webview-occlusion'
import { cn } from '@/lib/utils'
import { useOverlayRegistration } from '@/stores/overlay-stack-store'

export interface GalleryImage {
  /** Displayable source (object URL, data URL or https URL). */
  src: string
  alt: string
  /** File name offered by the download button. */
  fileName: string
}

interface ImageGalleryLightboxProps {
  images: readonly GalleryImage[]
  /** The slide shown when the lightbox opens; null keeps it closed. */
  openIndex: number | null
  /** The element that opened the viewer; it gets focus back on close. */
  opener: HTMLElement | null
  onClose: () => void
  onDownload: (image: GalleryImage) => void
}

const TOOLBAR_BUTTON_CLASS =
  'flex size-11 items-center justify-center rounded-full text-primary-foreground/90 transition-colors hover:bg-primary-foreground/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground/40'
const NAV_BUTTON_CLASS =
  'absolute top-1/2 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full bg-primary-foreground/10 text-primary-foreground/90 backdrop-blur transition-colors hover:bg-primary-foreground/20 disabled:pointer-events-none disabled:opacity-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground/40 sm:flex'

function clampIndex(index: number, count: number): number {
  return Math.min(Math.max(index, 0), Math.max(count - 1, 0))
}

/**
 * Full-screen viewer for one or more chat images: close at the top left,
 * download at the top right, a swipeable scroll-snap track, an "n of m"
 * counter, and previous/next buttons plus arrow keys on wider screens.
 */
export function ImageGalleryLightbox({
  images,
  openIndex,
  opener,
  onClose,
  onDownload
}: ImageGalleryLightboxProps): React.JSX.Element {
  const count = images.length
  const open = openIndex !== null && count > 0
  const id = `image-lightbox:${useId()}`
  useOverlayRegistration(id, open, onClose, { mobileShellOnly: true })
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [index, setIndex] = useState(0)
  const active = clampIndex(index, count)
  const current = images[active]

  // The caller clears `opener` as it closes, before the close focus runs.
  const openerRef = useRef<HTMLElement | null>(null)
  if (opener) openerRef.current = opener

  const startIndexRef = useRef(0)
  startIndexRef.current = clampIndex(openIndex ?? 0, count)
  // The track mounts each time the dialog opens: start at the tapped image
  // before the first paint.
  const trackCallbackRef = useCallback((node: HTMLDivElement | null) => {
    trackRef.current = node
    if (!node) return
    setIndex(startIndexRef.current)
    node.scrollLeft = startIndexRef.current * node.clientWidth
  }, [])

  const scrollTo = useCallback(
    (next: number) => {
      const track = trackRef.current
      if (!track) return
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      track.scrollTo({
        left: clampIndex(next, count) * track.clientWidth,
        behavior: reduced ? 'auto' : 'smooth'
      })
    },
    [count]
  )

  useEffect(() => {
    if (!open || count < 2) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowRight') scrollTo(active + 1)
      if (event.key === 'ArrowLeft') scrollTo(active - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, active, count, scrollTo])

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
          onCloseAutoFocus={(event) => {
            // No Radix trigger owns this dialog, so focus goes back by hand.
            event.preventDefault()
            const target = openerRef.current
            openerRef.current = null
            if (target?.isConnected) target.focus()
          }}
        >
          <NativeWebviewOccluder />
          <DialogPrimitive.Title className="sr-only">
            {current?.alt || 'Image'}
          </DialogPrimitive.Title>
          <div className="flex shrink-0 items-center justify-between px-2 pt-[max(env(safe-area-inset-top),0.5rem)]">
            <DialogPrimitive.Close aria-label="Close image" className={TOOLBAR_BUTTON_CLASS}>
              <X className="size-5" />
            </DialogPrimitive.Close>
            {current && (
              <button
                type="button"
                aria-label={`Download ${current.fileName}`}
                className={TOOLBAR_BUTTON_CLASS}
                onClick={() => onDownload(current)}
              >
                <Download className="size-5" />
              </button>
            )}
          </div>
          <div className="relative min-h-0 flex-1">
            <div
              ref={trackCallbackRef}
              role="region"
              aria-roledescription="carousel"
              aria-label="Images"
              data-testid="image-gallery-track"
              className="flex h-full snap-x snap-mandatory overflow-x-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              onScroll={(event) => {
                const track = event.currentTarget
                setIndex(Math.round(track.scrollLeft / Math.max(track.clientWidth, 1)))
              }}
            >
              {images.map((image, i) => (
                <div
                  key={`${i}:${image.src}`}
                  role="group"
                  aria-roledescription="slide"
                  aria-label={`${i + 1} of ${count}`}
                  className="flex h-full w-full shrink-0 snap-center items-center justify-center px-4"
                  onClick={(event) => {
                    if (event.target === event.currentTarget) onClose()
                  }}
                >
                  <img
                    src={image.src}
                    alt={image.alt}
                    draggable={false}
                    className="max-h-full max-w-full select-none object-contain"
                  />
                </div>
              ))}
            </div>
            {count > 1 && (
              <>
                <button
                  type="button"
                  aria-label="Previous image"
                  disabled={active === 0}
                  className={cn(NAV_BUTTON_CLASS, 'left-4')}
                  onClick={() => scrollTo(active - 1)}
                >
                  <ChevronLeft className="size-5" />
                </button>
                <button
                  type="button"
                  aria-label="Next image"
                  disabled={active >= count - 1}
                  className={cn(NAV_BUTTON_CLASS, 'right-4')}
                  onClick={() => scrollTo(active + 1)}
                >
                  <ChevronRight className="size-5" />
                </button>
              </>
            )}
          </div>
          <div
            aria-live="polite"
            className="flex h-16 shrink-0 items-center justify-center pb-[env(safe-area-inset-bottom)] text-sm tabular-nums text-primary-foreground/90"
          >
            {count > 1 ? `${active + 1} of ${count}` : null}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
