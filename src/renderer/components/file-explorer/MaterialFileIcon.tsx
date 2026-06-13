import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { formatMaterialIconSvg, getMaterialIconSvg } from './material-icon-catalog'
import type { MaterialIconResolveInput } from './material-icon-resolver'

interface MaterialFileIconProps extends MaterialIconResolveInput {
  size?: number
  className?: string
}

export function MaterialFileIcon({
  name,
  extension,
  isDirectory,
  isExpanded,
  depth,
  size = 14,
  className
}: MaterialFileIconProps): React.JSX.Element | null {
  const appearanceMode = useAppSettingsStore((state) => state.settings.appearanceMode)

  const markup = useMemo(() => {
    const svg = getMaterialIconSvg(
      { name, extension, isDirectory, isExpanded, depth },
      appearanceMode
    )
    if (!svg) return null
    return formatMaterialIconSvg(svg, size)
  }, [appearanceMode, depth, extension, isDirectory, isExpanded, name, size])

  const iconSrc = useMemo(() => {
    if (!markup) return null
    return `data:image/svg+xml,${encodeURIComponent(markup)}`
  }, [markup])

  if (!iconSrc) {
    return null
  }

  return (
    <img
      src={iconSrc}
      alt=""
      aria-hidden
      width={size}
      height={size}
      className={cn('inline-flex flex-shrink-0', className)}
      draggable={false}
    />
  )
}
