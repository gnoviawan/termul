import { useState } from 'react'
import { useMediaObjectUrlState } from '@/hooks/use-media-object-url'
import { basename } from '@/lib/path-basename'
import { formatSize } from '@/lib/sftp-format'
import { previewUnavailableFromRead, UnsupportedFileView } from './UnsupportedFileView'
import { ViewerFooter, ViewerLoading } from './viewer-chrome'

interface VideoMetadata {
  width: number
  height: number
  duration: number
}

/** `m:ss`, or `h:mm:ss` from an hour up. */
function formatDuration(seconds: number): string {
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

export function VideoViewer({
  filePath,
  revision
}: {
  filePath: string
  revision: number
}): React.JSX.Element {
  const media = useMediaObjectUrlState(filePath, revision)
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null)

  if (media.status === 'loading') return <ViewerLoading />
  if (media.status === 'error') {
    return (
      <UnsupportedFileView
        filePath={filePath}
        unavailable={previewUnavailableFromRead(media.code, media.message)}
      />
    )
  }

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        {/* biome-ignore lint/a11y/useMediaCaption: a workspace file has no caption track */}
        <video
          src={media.url}
          controls
          aria-label={basename(filePath)}
          className="max-h-full max-w-full"
          onLoadedMetadata={(event) => {
            const video = event.currentTarget
            setMetadata({
              width: video.videoWidth,
              height: video.videoHeight,
              duration: video.duration
            })
          }}
        />
      </div>
      <ViewerFooter
        facts={[
          metadata && metadata.width > 0 ? `${metadata.width} × ${metadata.height}` : null,
          metadata && Number.isFinite(metadata.duration) ? formatDuration(metadata.duration) : null,
          formatSize(media.size)
        ]}
      />
    </div>
  )
}
