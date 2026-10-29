import { useEffect, useState } from 'react'
import { readMediaBytes } from '@/lib/media-bytes-api'

/**
 * A `blob:` URL for the media file at `path`, or null while it loads, when the
 * read fails, or when `path` is null. The URL is revoked when `path` changes
 * and on unmount, and a result for an earlier path is never returned.
 * `readMediaBytes` logs read failures.
 */
export function useMediaObjectUrl(path: string | null): string | null {
  const [loaded, setLoaded] = useState<{ path: string; url: string } | null>(null)

  useEffect(() => {
    if (!path) return
    let cancelled = false
    let url: string | null = null
    void readMediaBytes(path).then((result) => {
      if (cancelled || !result.success) return
      url = URL.createObjectURL(result.data)
      setLoaded({ path, url })
    })
    return () => {
      cancelled = true
      if (!url) return
      const revoked = url
      URL.revokeObjectURL(revoked)
      setLoaded((current) => (current?.url === revoked ? null : current))
    }
  }, [path])

  return loaded !== null && loaded.path === path ? loaded.url : null
}
