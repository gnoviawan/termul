import { useRef, useState } from 'react'
import { ZoomIn, ZoomOut } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { useMediaObjectUrlState } from '@/hooks/use-media-object-url'
import { basename } from '@/lib/path-basename'
import { formatSize } from '@/lib/sftp-format'
import { cn } from '@/lib/utils'
import { previewUnavailableFromRead, UnsupportedFileView } from './UnsupportedFileView'
import { CHECKERBOARD_CLASS, ViewerFooter, ViewerLoading } from './viewer-chrome'

const ZOOM_STEP = 1.25
const MIN_SCALE = 0.05
const MAX_SCALE = 16

/** `fit` scales the image down to the pane; a number is pixels per image pixel. */
type Zoom = 'fit' | number

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

export function ImageViewer({
  filePath,
  revision
}: {
  filePath: string
  revision: number
}): React.JSX.Element {
  const media = useMediaObjectUrlState(filePath, revision)
  const [zoom, setZoom] = useState<Zoom>('fit')
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const imageRef = useRef<HTMLImageElement>(null)

  if (media.status === 'loading') return <ViewerLoading />
  if (media.status === 'error') {
    return (
      <UnsupportedFileView
        filePath={filePath}
        unavailable={previewUnavailableFromRead(media.code, media.message)}
      />
    )
  }

  /** The scale on screen now; in fit mode, the one the layout chose. */
  const shownScale = (): number => {
    if (zoom !== 'fit') return zoom
    const image = imageRef.current
    return image && image.naturalWidth > 0 ? image.clientWidth / image.naturalWidth : 1
  }

  const scaled = zoom !== 'fit' && natural !== null
  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="relative min-h-0 flex-1 overflow-auto">
        <div
          className={cn(
            'flex items-center justify-center p-4',
            scaled ? 'min-h-full min-w-full w-max' : 'absolute inset-0'
          )}
        >
          <img
            ref={imageRef}
            src={media.url}
            alt={basename(filePath)}
            draggable={false}
            onLoad={(event) =>
              setNatural({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight
              })
            }
            className={cn(CHECKERBOARD_CLASS, scaled ? 'max-w-none' : 'max-h-full max-w-full')}
            style={
              scaled ? { width: natural.width * zoom, height: natural.height * zoom } : undefined
            }
          />
        </div>
      </div>
      <ViewerFooter
        facts={[
          natural ? `${natural.width} × ${natural.height}` : null,
          formatSize(media.size),
          zoom === 'fit' ? null : `${Math.round(zoom * 100)}%`
        ]}
      >
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => setZoom(clampScale(shownScale() / ZOOM_STEP))}
        >
          <ZoomOut size={14} aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => setZoom(clampScale(shownScale() * ZOOM_STEP))}
        >
          <ZoomIn size={14} aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          aria-pressed={zoom === 1}
          title="Actual size"
          onClick={() => setZoom(1)}
        >
          1:1
        </Button>
        <Button
          variant="ghost"
          size="xs"
          aria-pressed={zoom === 'fit'}
          title="Fit to pane"
          onClick={() => setZoom('fit')}
        >
          Fit
        </Button>
      </ViewerFooter>
    </div>
  )
}
