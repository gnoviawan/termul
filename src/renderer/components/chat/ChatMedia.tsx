import { type ReactNode, useEffect, useState } from 'react'
import { VideoIcon } from '@/components/icons'
import { ImageLightbox } from '@/components/ui/image-lightbox'
import { useMediaObjectUrl } from '@/hooks/use-media-object-url'
import { logFrontendError } from '@/lib/log-api'
import type { BytesSource, ChatMedia as ChatMediaModel } from './chat-media-source'

/** `inline` sizes media for prose; `tile` is the square attachment-grid thumbnail. */
export type ChatMediaLayout = 'inline' | 'tile'

/** A `blob:` URL for inline base64 bytes, revoked when the bytes change or on unmount. */
function useBytesObjectUrl(source: BytesSource | null): string | null {
  const base64 = source?.base64 ?? null
  const mime = source?.mime ?? ''
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (base64 === null) return
    let created: string
    try {
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      created = URL.createObjectURL(new Blob([bytes], { type: mime }))
    } catch (error) {
      void logFrontendError({
        level: 'warn',
        source: 'ChatMedia.bytes',
        message: `Failed to decode inline ${mime || 'media'} bytes: ${String(error)}`
      })
      return
    }
    setUrl(created)
    return () => {
      URL.revokeObjectURL(created)
      setUrl(null)
    }
  }, [base64, mime])

  return base64 === null ? null : url
}

/**
 * The URL an element can load for `media`, or null while it is not ready.
 * A local file is read only once `loadPath` is true.
 */
function useChatMediaUrl(media: ChatMediaModel, loadPath: boolean): string | null {
  const { src } = media
  const pathUrl = useMediaObjectUrl(src.from === 'path' && loadPath ? src.path : null)
  const bytesUrl = useBytesObjectUrl(src.from === 'bytes' ? src : null)
  switch (src.from) {
    case 'url':
      return src.url
    case 'path':
      return pathUrl
    case 'bytes':
      return bytesUrl
  }
}

/** Muted stand-in for media that is loading or cannot render. */
export function MediaAltChip({ alt }: { alt: string }): React.JSX.Element {
  return (
    <span
      data-testid="chat-media-alt"
      title={alt}
      className="inline-flex max-w-[16rem] items-center rounded border border-border/40 bg-muted/40 px-1.5 py-0.5 align-middle text-xs text-muted-foreground"
    >
      <span className="truncate">{alt || 'image'}</span>
    </span>
  )
}

function ChatImage({
  media,
  layout,
  fallback
}: {
  media: ChatMediaModel
  layout: ChatMediaLayout
  fallback: ReactNode
}): React.JSX.Element {
  const src = useChatMediaUrl(media, true)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (!src || failedSrc === src) return <>{fallback}</>
  return (
    <ImageLightbox src={src} alt={media.name}>
      <img
        src={src}
        alt={media.name}
        title={media.name}
        className={
          layout === 'tile'
            ? 'size-24 rounded-lg bg-muted object-cover'
            : 'max-h-96 max-w-full rounded-md'
        }
        width={layout === 'tile' ? 96 : undefined}
        height={layout === 'tile' ? 96 : undefined}
        onError={() => {
          setFailedSrc(src)
          void logFrontendError({
            level: 'warn',
            source: 'ChatMedia.image',
            message: `Failed to display chat image '${media.name}': image decode/load failed`
          })
        }}
      />
    </ImageLightbox>
  )
}

/**
 * A local video is read whole (up to 100 MiB) before it can play, so it loads
 * on an explicit click rather than on mount or on scroll: a long transcript
 * never pulls videos the user only scrolls past, which matters most on the
 * web client over a phone connection. Remote and inline videos stream or are
 * already in memory, so they render the player directly.
 */
function ChatVideo({ media }: { media: ChatMediaModel }): React.JSX.Element {
  const [requested, setRequested] = useState(false)
  const src = useChatMediaUrl(media, requested)
  const local = media.src.from === 'path'

  if (src) {
    return (
      // biome-ignore lint/a11y/useMediaCaption: agent-produced videos carry no caption tracks.
      <video
        aria-label={media.name}
        className="max-h-96 max-w-full rounded-md bg-muted"
        controls
        autoPlay={local}
        preload={
          media.src.from === 'url' && media.src.url.startsWith('https:') ? 'none' : 'metadata'
        }
        src={src}
        onError={() => {
          void logFrontendError({
            level: 'warn',
            source: 'ChatMedia.video',
            message: `Failed to play chat video '${media.name}': load/decode failed`
          })
        }}
      />
    )
  }
  return (
    <button
      type="button"
      aria-label={`Play video: ${media.name}`}
      aria-busy={requested}
      disabled={requested || !local}
      onClick={() => setRequested(true)}
      className="inline-flex h-24 w-48 max-w-full cursor-pointer flex-col items-center justify-center gap-1.5 rounded-md border border-border/40 bg-muted/40 px-3 text-xs text-muted-foreground hover:bg-muted/60 disabled:cursor-default"
    >
      <VideoIcon className="size-5" />
      <span className="max-w-full truncate">{requested ? 'Loading video' : media.name}</span>
    </button>
  )
}

function ChatAudio({ media }: { media: ChatMediaModel }): React.JSX.Element | null {
  const src = useChatMediaUrl(media, true)
  if (!src) return null
  return (
    // biome-ignore lint/a11y/useMediaCaption: ACP audio blocks do not provide caption tracks.
    <audio
      aria-label={`Play ${media.name}`}
      className="max-w-full"
      controls
      preload="metadata"
      src={src}
    />
  )
}

/**
 * Renders any chat media: an image that opens in the lightbox, a video
 * player, or an audio player. `fallback` shows while an image loads or when
 * it cannot render.
 */
export function ChatMedia({
  media,
  layout = 'inline',
  fallback
}: {
  media: ChatMediaModel
  layout?: ChatMediaLayout
  fallback?: ReactNode
}): React.JSX.Element | null {
  switch (media.kind) {
    case 'image':
      return (
        <ChatImage
          media={media}
          layout={layout}
          fallback={fallback ?? <MediaAltChip alt={media.name} />}
        />
      )
    case 'video':
      return <ChatVideo media={media} />
    case 'audio':
      return <ChatAudio media={media} />
  }
}
