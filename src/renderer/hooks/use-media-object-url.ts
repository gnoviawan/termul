import { useEffect, useMemo, useState } from 'react'
import { type MediaReadCode, type MediaReadResult, readMediaBytes } from '@/lib/media-bytes-api'

export type MediaObjectUrlState =
  | { status: 'loading' }
  | { status: 'ready'; url: string; size: number }
  | { status: 'error'; code: MediaReadCode; message: string; size?: number; limit?: number }

type Settled = Exclude<MediaObjectUrlState, { status: 'loading' }>

export function useMediaObjectUrlState(path: string | null, revision = 0): MediaObjectUrlState {
  const [loaded, setLoaded] = useState<{ path: string; state: Settled } | null>(null)
  const request = useMemo(() => (path ? { path, revision } : null), [path, revision])

  useEffect(() => {
    if (!request) return
    let cancelled = false
    void readMediaBytes(request.path).then((result) => {
      if (cancelled) return
      setLoaded({ path: request.path, state: settle(result) })
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

function settle(result: MediaReadResult): Settled {
  if (result.success) {
    return { status: 'ready', url: URL.createObjectURL(result.data), size: result.data.size }
  }
  const { code, error: message, size, limit } = result
  return size !== undefined && limit !== undefined
    ? { status: 'error', code, message, size, limit }
    : { status: 'error', code, message }
}
