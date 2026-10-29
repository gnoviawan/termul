import { useEffect, useMemo, useState } from 'react'
import { readMediaBytes } from '@/lib/media-bytes-api'

export type MediaObjectUrlState =
  | { status: 'loading' }
  | { status: 'ready'; url: string; size: number }
  | { status: 'error'; code: string; message: string }

type Settled = Exclude<MediaObjectUrlState, { status: 'loading' }>

export function useMediaObjectUrlState(path: string | null, revision = 0): MediaObjectUrlState {
  const [loaded, setLoaded] = useState<{ path: string; state: Settled } | null>(null)
  const request = useMemo(() => (path ? { path, revision } : null), [path, revision])

  useEffect(() => {
    if (!request) return
    let cancelled = false
    void readMediaBytes(request.path).then((result) => {
      if (cancelled) return
      setLoaded({
        path: request.path,
        state: result.success
          ? { status: 'ready', url: URL.createObjectURL(result.data), size: result.data.size }
          : { status: 'error', code: result.code, message: result.error }
      })
    })
    return () => {
      cancelled = true
    }
  }, [request])

  const url = loaded?.state.status === 'ready' ? loaded.state.url : null
  useEffect(() => {
    if (!url) return
    return () => URL.revokeObjectURL(url)
  }, [url])

  return loaded !== null && loaded.path === path ? loaded.state : { status: 'loading' }
}

export function useMediaObjectUrl(path: string | null): string | null {
  const state = useMediaObjectUrlState(path)
  return state.status === 'ready' ? state.url : null
}
