import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

import { cn } from '@/lib/utils'

interface ImageLightboxProps {
  /** Full-resolution image source shown when expanded. */
  src: string
  alt: string
  /** The thumbnail trigger; rendered via `asChild` so it stays the DOM element. */
  children: React.ReactNode
}

/**
 * Wraps a thumbnail trigger and opens the image full-screen on click. Click the
 * image, the close button, or press Escape to dismiss.
 */
export function ImageLightbox({ src, alt, children }: ImageLightboxProps): React.JSX.Element {
  return (
    <DialogPrimitive.Root>
      <DialogPrimitive.Trigger asChild>{children}</DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 outline-none',
            'data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95'
          )}
        >
          <DialogPrimitive.Title className="sr-only">{alt}</DialogPrimitive.Title>
          <img
            src={src}
            alt={alt}
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl outline outline-1 -outline-offset-1 outline-white/10"
          />
          <DialogPrimitive.Close
            aria-label="Close image"
            className="fixed right-4 top-4 flex size-9 items-center justify-center rounded-full bg-white/10 text-white/90 backdrop-blur transition-colors hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
