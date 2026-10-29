import { type ReactNode, useEffect, useState } from 'react'
import { VideoIcon } from '@/components/icons'
import { ImageLightbox } from '@/components/ui/image-lightbox'
import { type MediaObjectUrlState, useMediaObjectUrlState } from '@/hooks/use-media-object-url'
import { logFrontendError } from '@/lib/log-api'
import { formatSize } from '@/lib/sftp-format'
import type { BytesSource, ChatMedia as ChatMediaModel } from './chat-media-source'

export type ChatMediaLayout = 'inline' | 'tile'

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

type ReadFailure = Extract<MediaObjectUrlState, { status: 'error' }>

type ChatMediaState = { status: 'loading' } | { status: 'ready'; url: string } | ReadFailure

function useChatMediaState(media: ChatMediaModel, loadPath: boolean): ChatMediaState {
  const { src } = media
  const pathState = useMediaObjectUrlState(src.from === 'path' && loadPath ? src.path : null, 0)
  const bytesUrl = useBytesObjectUrl(src.from === 'bytes' ? src : null)
  switch (src.from) {
    case 'url':
      return { status: 'ready', url: src.url }
    case 'path':
      return pathState
    case 'bytes':
      return bytesUrl ? { status: 'ready', url: bytesUrl } : { status: 'loading' }
  }
}

function readFailureText(name: string, verb: 'play' | 'show', failure: ReadFailure): string {
  switch (failure.code) {
    case 'FILE_TOO_LARGE': {
      const detail =
        failure.size !== undefined && failure.limit !== undefined
          ? ` (${formatSize(failure.size)}, limit ${formatSize(failure.limit)})`
          : ''
      return `${name} is too large to ${verb} inline${detail}`
    }
    case 'NOT_FOUND':
      return `${name} was not found`
    default:
      return `${name} couldn't be read`
  }
}

export function MediaAltChip({ alt, title }: { alt: string; title?: string }): React.JSX.Element {
  return (
    <span
      data-testid="chat-media-alt"
      title={title ?? alt}
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
  fallback?: ReactNode
}): React.JSX.Element {
  const state = useChatMediaState(media, true)
  const src = state.status === 'ready' ? state.url : null
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (!src || failedSrc === src) {
    const reason = state.status === 'error' ? readFailureText(media.name, 'show', state) : undefined
    return <>{fallback ?? <MediaAltChip alt={media.name} title={reason} />}</>
  }
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

function ChatVideo({ media }: { media: ChatMediaModel }): React.JSX.Element {
  const [requested, setRequested] = useState(false)
  const state = useChatMediaState(media, requested)
  const local = media.src.from === 'path'

  if (state.status === 'error') {
    const reason = readFailureText(media.name, 'play', state)
    return (
      <div
        role="status"
        title={reason}
        className="inline-flex min-h-24 w-64 max-w-full flex-col items-center justify-center gap-1.5 rounded-md border border-border/40 bg-muted/40 px-3 py-2 text-center text-xs text-muted-foreground"
      >
        <VideoIcon className="size-5" />
        <span className="max-w-full break-words">{reason}</span>
      </div>
    )
  }
  if (state.status === 'ready') {
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
        src={state.url}
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
  const state = useChatMediaState(media, true)
  if (state.status !== 'ready') return null
  return (
    // biome-ignore lint/a11y/useMediaCaption: ACP audio blocks do not provide caption tracks.
    <audio
      aria-label={`Play ${media.name}`}
      className="max-w-full"
      controls
      preload="metadata"
      src={state.url}
    />
  )
}

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
      return <ChatImage media={media} layout={layout} fallback={fallback} />
    case 'video':
      return <ChatVideo media={media} />
    case 'audio':
      return <ChatAudio media={media} />
  }
}
