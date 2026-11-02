import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { VideoIcon } from '@/components/icons'
import { ImageGalleryLightbox } from '@/components/ui/image-gallery-lightbox'
import { ImageLightbox } from '@/components/ui/image-lightbox'
import { type MediaObjectUrlState, useMediaObjectUrlState } from '@/hooks/use-media-object-url'
import { dataUrlMime, downloadImage, imageFileName } from '@/lib/image-download'
import { logFrontendError } from '@/lib/log-api'
import { mediaKindForPath } from '@/lib/media-kind'
import { basename } from '@/lib/path-basename'
import { formatSize } from '@/lib/sftp-format'
import type { BytesSource, ChatMedia as ChatMediaModel } from './chat-media-source'

type ReadFailure = Extract<MediaObjectUrlState, { status: 'error' }>

type ChatMediaState = { status: 'loading' } | { status: 'ready'; url: string } | ReadFailure

function useBytesObjectUrl(source: BytesSource | null): ChatMediaState {
  const base64 = source?.base64 ?? null
  const mime = source?.mime ?? ''
  const [state, setState] = useState<ChatMediaState>({ status: 'loading' })

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
      setState({ status: 'error', code: 'READ_ERROR', message: String(error) })
      return
    }
    setState({ status: 'ready', url: created })
    return () => {
      URL.revokeObjectURL(created)
      setState({ status: 'loading' })
    }
  }, [base64, mime])

  return state
}

function useChatMediaState(media: ChatMediaModel, loadPath: boolean): ChatMediaState {
  const { src } = media
  const pathState = useMediaObjectUrlState(src.from === 'path' && loadPath ? src.path : null, 0)
  const bytesState = useBytesObjectUrl(src.from === 'bytes' ? src : null)
  switch (src.from) {
    case 'url':
      return { status: 'ready', url: src.url }
    case 'path':
      return pathState
    case 'bytes':
      return bytesState
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

interface ImageSource {
  /** The displayable URL, or null while loading or after a read or decode failure. */
  src: string | null
  failureText?: string
  onError: () => void
}

function useImageSource(media: ChatMediaModel): ImageSource {
  const state = useChatMediaState(media, true)
  const loaded = state.status === 'ready' ? state.url : null
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  return {
    src: loaded !== null && loaded !== failedSrc ? loaded : null,
    failureText: state.status === 'error' ? readFailureText(media.name, 'show', state) : undefined,
    onError: () => {
      setFailedSrc(loaded)
      void logFrontendError({
        level: 'warn',
        source: 'ChatMedia.image',
        message: `Failed to display chat image '${media.name}': image decode/load failed`
      })
    }
  }
}

function sourceBaseName(src: ChatMediaModel['src']): string {
  if (src.from === 'path') return basename(src.path)
  if (src.from !== 'url' || !/^https?:/i.test(src.url)) return ''
  try {
    return decodeURIComponent(basename(new URL(src.url).pathname))
  } catch {
    return ''
  }
}

/** The download name: the file's own image name, else the image's name, with an image extension. */
export function mediaFileName(media: ChatMediaModel): string {
  const base = sourceBaseName(media.src)
  const mime =
    media.src.from === 'bytes'
      ? media.src.mime
      : dataUrlMime(media.src.from === 'url' ? media.src.url : '')
  return imageFileName(mediaKindForPath(base) === 'image' ? base : media.name || base, mime)
}

function saveChatImage(media: ChatMediaModel, fileName: string): void {
  downloadImage(media.src, fileName).catch((error: unknown) => {
    void logFrontendError({
      level: 'warn',
      source: 'ChatMedia.download',
      message: `Failed to save chat image '${fileName}': ${String(error)}`
    })
    toast.error('Failed to download image')
  })
}

function ChatImage({ media }: { media: ChatMediaModel }): React.JSX.Element {
  const { src, failureText, onError } = useImageSource(media)
  if (!src) return <MediaAltChip alt={media.name} title={failureText} />
  const fileName = mediaFileName(media)
  return (
    <ImageLightbox
      image={{ src, alt: media.name, fileName }}
      onDownload={() => saveChatImage(media, fileName)}
    >
      <img
        src={src}
        alt={media.name}
        title={media.name}
        className="max-h-96 max-w-full rounded-md"
        onError={onError}
      />
    </ImageLightbox>
  )
}

/** An image in a set of tiles that share one viewer; `key` is unique within the set. */
export interface ChatImageEntry {
  key: string
  media: ChatMediaModel
}

export interface ChatImageViewer {
  /** A tile reports its displayable URL, or null when it cannot show. */
  onReady: (key: string, src: string | null) => void
  /** `opener` gets focus back when the viewer closes. */
  onOpen: (key: string, opener: HTMLElement) => void
  /** The shared viewer element; render it once next to the tiles. */
  lightbox: React.JSX.Element
}

/**
 * One viewer across a set of image tiles. Tiles report the object URLs they
 * already resolved, so the viewer never reads the bytes again, and a tile that
 * fails to load is left out of it.
 */
export function useChatImageViewer(entries: readonly ChatImageEntry[]): ChatImageViewer {
  const [srcs, setSrcs] = useState<Readonly<Record<string, string | null>>>({})
  const [open, setOpen] = useState<{ key: string; opener: HTMLElement } | null>(null)
  const onReady = useCallback((key: string, src: string | null) => {
    setSrcs((prev) => (prev[key] === src ? prev : { ...prev, [key]: src }))
  }, [])
  const ready = entries.flatMap(({ key, media }) => {
    const src = srcs[key]
    return src
      ? [{ key, media, image: { src, alt: media.name, fileName: mediaFileName(media) } }]
      : []
  })
  const openIndex = ready.findIndex((entry) => entry.key === open?.key)
  const onOpen = useCallback((key: string, opener: HTMLElement) => setOpen({ key, opener }), [])
  return {
    onReady,
    onOpen,
    lightbox: (
      <ImageGalleryLightbox
        images={ready.map((entry) => entry.image)}
        openIndex={openIndex === -1 ? null : openIndex}
        opener={open?.opener ?? null}
        onClose={() => setOpen(null)}
        onDownload={(image) => {
          const entry = ready.find((candidate) => candidate.image === image)
          if (entry) saveChatImage(entry.media, image.fileName)
        }}
      />
    )
  }
}

export type ChatImageTileSize = 'attachment' | 'gallery'

const TILE_STYLES: Readonly<
  Record<ChatImageTileSize, { px: number; button: string; image: string }>
> = {
  attachment: {
    px: 96,
    button: 'inline-flex cursor-zoom-in items-center rounded-lg bg-transparent p-0',
    image: 'size-24 rounded-lg bg-muted object-cover'
  },
  gallery: {
    px: 112,
    button: 'shrink-0 snap-start cursor-zoom-in rounded-xl bg-transparent p-0',
    image: 'size-28 rounded-xl bg-muted object-cover'
  }
}

export function ChatImageTile({
  entry,
  size,
  viewer,
  fallback
}: {
  entry: ChatImageEntry
  size: ChatImageTileSize
  viewer: Pick<ChatImageViewer, 'onReady' | 'onOpen'>
  /** Shown while the image loads and in its place when it cannot show. */
  fallback: (failureText: string | undefined) => ReactNode
}): React.JSX.Element {
  const { key, media } = entry
  const { src, failureText, onError } = useImageSource(media)
  const { onReady, onOpen } = viewer
  useEffect(() => onReady(key, src), [onReady, key, src])
  if (!src) return <>{fallback(failureText)}</>
  const style = TILE_STYLES[size]
  return (
    <button
      type="button"
      aria-label={`Open image: ${media.name}`}
      className={style.button}
      onClick={(event) => onOpen(key, event.currentTarget)}
    >
      <img
        src={src}
        alt={media.name}
        title={media.name}
        width={style.px}
        height={style.px}
        className={style.image}
        onError={onError}
      />
    </button>
  )
}

function GalleryAltTile({ alt, title }: { alt: string; title?: string }): React.JSX.Element {
  return (
    <div className="flex size-28 shrink-0 items-center justify-center rounded-xl bg-muted/50 p-2">
      <MediaAltChip alt={alt} title={title} />
    </div>
  )
}

/** A markdown image in a gallery strip; null media cannot render and shows its alt text. */
export interface ChatGalleryItem {
  alt: string
  media: ChatMediaModel | null
}

/** Several consecutive markdown images: one horizontal strip of square tiles. */
export function ChatImageGallery({
  items
}: {
  items: readonly ChatGalleryItem[]
}): React.JSX.Element {
  const keyed = items.map((item, index) => ({ ...item, key: String(index) }))
  const viewer = useChatImageViewer(
    keyed.flatMap(({ key, media }) => (media ? [{ key, media }] : []))
  )
  return (
    <>
      <div
        role="group"
        aria-label={`${items.length} images`}
        data-testid="chat-image-gallery"
        className="my-2 flex snap-x gap-2 overflow-x-auto pb-1 [scrollbar-width:thin] pointer-coarse:[scrollbar-width:none] pointer-coarse:[&::-webkit-scrollbar]:hidden"
      >
        {keyed.map(({ key, alt, media }) =>
          media ? (
            <ChatImageTile
              key={key}
              entry={{ key, media }}
              size="gallery"
              viewer={viewer}
              fallback={(failureText) => <GalleryAltTile alt={alt} title={failureText} />}
            />
          ) : (
            <GalleryAltTile key={key} alt={alt} />
          )
        )}
      </div>
      {viewer.lightbox}
    </>
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
  if (state.status === 'error') {
    return (
      <span role="status" className="text-xs text-muted-foreground">
        {readFailureText(media.name, 'play', state)}
      </span>
    )
  }
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

export function ChatMedia({ media }: { media: ChatMediaModel }): React.JSX.Element | null {
  switch (media.kind) {
    case 'image':
      return <ChatImage media={media} />
    case 'video':
      return <ChatVideo media={media} />
    case 'audio':
      return <ChatAudio media={media} />
  }
}
