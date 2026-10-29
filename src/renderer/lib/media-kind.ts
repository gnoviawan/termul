import { basename } from './path-basename'

export type MediaKind = 'image' | 'video' | 'pdf'

const MIB = 1024 * 1024

export const MEDIA_MAX_BYTES: Readonly<Record<MediaKind, number>> = {
  image: 25 * MIB,
  video: 100 * MIB,
  pdf: 50 * MIB
}

export const MEDIA_TYPES: Readonly<Record<string, { kind: MediaKind; mime: string }>> = {
  png: { kind: 'image', mime: 'image/png' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  gif: { kind: 'image', mime: 'image/gif' },
  webp: { kind: 'image', mime: 'image/webp' },
  bmp: { kind: 'image', mime: 'image/bmp' },
  avif: { kind: 'image', mime: 'image/avif' },
  ico: { kind: 'image', mime: 'image/x-icon' },
  svg: { kind: 'image', mime: 'image/svg+xml' },
  mp4: { kind: 'video', mime: 'video/mp4' },
  m4v: { kind: 'video', mime: 'video/mp4' },
  webm: { kind: 'video', mime: 'video/webm' },
  mov: { kind: 'video', mime: 'video/quicktime' },
  ogv: { kind: 'video', mime: 'video/ogg' },
  pdf: { kind: 'pdf', mime: 'application/pdf' }
}

function mediaTypeForPath(path: string): { kind: MediaKind; mime: string } | null {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = name.slice(dot + 1).toLowerCase()
  return Object.hasOwn(MEDIA_TYPES, ext) ? MEDIA_TYPES[ext] : null
}

export function mediaKindForPath(path: string): MediaKind | null {
  return mediaTypeForPath(path)?.kind ?? null
}

export function mediaMimeForPath(path: string): string | null {
  return mediaTypeForPath(path)?.mime ?? null
}
