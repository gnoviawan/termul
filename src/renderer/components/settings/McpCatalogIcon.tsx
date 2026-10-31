import type { McpCatalogIconUrl } from '@shared/types/mcp-catalog.types'
import { useEffect, useState } from 'react'
import { mcpCatalogApi } from '@/lib/mcp-catalog-api'

function useMcpCatalogIconUrl(name: string, hasIcon: boolean): McpCatalogIconUrl | null {
  const [loaded, setLoaded] = useState<{ name: string; url: McpCatalogIconUrl } | null>(null)

  useEffect(() => {
    if (!hasIcon) return
    let cancelled = false
    void mcpCatalogApi.icon(name).then((result) => {
      if (!cancelled && result.success) {
        setLoaded({ name, url: result.data })
      }
    })
    return () => {
      cancelled = true
    }
  }, [name, hasIcon])

  return hasIcon && loaded?.name === name ? loaded.url : null
}

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
