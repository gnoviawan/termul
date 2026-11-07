import { useState } from 'react'
import { type GalleryImage, ImageGalleryLightbox } from './image-gallery-lightbox'

interface ImageLightboxProps {
  image: GalleryImage
  onDownload: (image: GalleryImage) => void
  /** The thumbnail, rendered inside the focusable trigger button. */
  children: React.ReactNode
}

/**
 * Wraps a thumbnail and opens the image in the full-screen viewer on click.
 * The trigger is always a `<button>` so the viewer is keyboard-accessible even
 * when the thumbnail itself is a non-interactive `<img>`.
 */
export function ImageLightbox({
  image,
  onDownload,
  children
}: ImageLightboxProps): React.JSX.Element {
  const [opener, setOpener] = useState<HTMLElement | null>(null)
  return (
    <>
      <button
        type="button"
        aria-label={`Open image: ${image.alt}`}
        className="inline-flex cursor-zoom-in items-center bg-transparent p-0"
        onClick={(event) => setOpener(event.currentTarget)}
      >
        {children}
      </button>
      <ImageGalleryLightbox
        images={[image]}
        openIndex={opener ? 0 : null}
        opener={opener}
        onClose={() => setOpener(null)}
        onDownload={onDownload}
      />
    </>
  )
}
