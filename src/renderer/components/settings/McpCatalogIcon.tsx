import { useEffect, useState } from 'react'
import { mcpCatalogApi } from '@/lib/mcp-catalog-api'

/**
 * The row's logo as an object URL once the host serves it. Rows mount as
 * they scroll into view, so this loads lazily. `null` while loading, when the
 * row has no logo, or when the host couldn't get one.
 */
function useMcpCatalogIconUrl(name: string, hasIcon: boolean): string | null {
  const [loaded, setLoaded] = useState<{ name: string; url: string } | null>(null)

  useEffect(() => {
    if (!hasIcon) return
    let cancelled = false
    void mcpCatalogApi.icon(name).then((result) => {
      if (!cancelled && result.success) {
        setLoaded({ name, url: URL.createObjectURL(result.data) })
      }
    })
    return () => {
      cancelled = true
    }
  }, [name, hasIcon])

  const url = loaded?.url
  useEffect(() => {
    if (!url) return
    return () => URL.revokeObjectURL(url)
  }, [url])

  return hasIcon && loaded?.name === name ? loaded.url : null
}

/**
 * A 32px logo from host bytes, only ever through `<img>`, or the first letter
 * of `displayName` on a neutral tile.
 */
export function McpCatalogIcon({
  name,
  displayName,
  hasIcon
}: {
  name: string
  displayName: string
  hasIcon: boolean
}): React.JSX.Element {
  const url = useMcpCatalogIconUrl(name, hasIcon)
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null)

  if (url && url !== brokenUrl) {
    return (
      <img
        src={url}
        alt=""
        width={32}
        height={32}
        draggable={false}
        onError={() => setBrokenUrl(url)}
        className="size-8 shrink-0 rounded-md object-contain"
      />
    )
  }
  return (
    <span
      aria-hidden
      data-testid="mcp-catalog-icon-placeholder"
      className="flex size-8 shrink-0 select-none items-center justify-center rounded-md bg-muted text-sm font-medium text-muted-foreground"
    >
      {Array.from(displayName.trim())[0]?.toUpperCase() ?? '?'}
    </span>
  )
}
