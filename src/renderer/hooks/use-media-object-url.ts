import { useEffect, useState } from 'react'
import { readMediaBytes } from '@/lib/media-bytes-api'

export type MediaObjectUrlState =
  | { status: 'loading' }
  | { status: 'ready'; url: string; size: number }
  | { status: 'error'; code: string; message: string }

type Settled = Exclude<MediaObjectUrlState, { status: 'loading' }>

/**
 * Read the media file at `path` into a `blob:` URL. A new `revision` re-reads
 * it, and the previous URL stays on screen until that read settles, so a
 * reload never flashes. Each URL is revoked once replaced and on unmount, and
 * a result for an earlier path is never returned. `readMediaBytes` logs failures.
 */
export function useMediaObjectUrlState(path: string | null, revision = 0): MediaObjectUrlState {
  const [loaded, setLoaded] = useState<{ path: string; state: Settled } | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision intentionally re-reads the file
  useEffect(() => {
    if (!path) return
    let cancelled = false
    void readMediaBytes(path).then((result) => {
      if (cancelled) return
      setLoaded({
        path,
        state: result.success
          ? { status: 'ready', url: URL.createObjectURL(result.data), size: result.data.size }
          : { status: 'error', code: result.code, message: result.error }
      })
    })
    return () => {
      cancelled = true
    }
  }, [path, revision])

  const url = loaded?.state.status === 'ready' ? loaded.state.url : null
  useEffect(() => {
    if (!url) return
    return () => URL.revokeObjectURL(url)
  }, [url])

  return loaded !== null && loaded.path === path ? loaded.state : { status: 'loading' }
}

/**
 * A `blob:` URL for the media file at `path`, or null while it loads, when the
 * read fails, or when `path` is null.
 */
export function useMediaObjectUrl(path: string | null): string | null {
  const state = useMediaObjectUrlState(path)
  return state.status === 'ready' ? state.url : null
}
