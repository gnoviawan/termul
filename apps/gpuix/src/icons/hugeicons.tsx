/**
 * `@hugeicons/react`'s HugeiconsIcon for GPUIX. GPUIX paints `<svg source>`
 * as one monochrome shape tinted by `style.color`, so the icon data is
 * serialized once per stroke width with black paint, and `currentColor`
 * comes from the nearest ancestor's text colour (CurrentColorContext).
 * Duotone icons keep their secondary path's opacity but lose a second colour.
 */
import type { PublicInstance, StyleDesc } from '@gpuix/react'
import { forwardRef, type Ref, useContext } from 'react'
import { tw } from '../style/tw'
import { CurrentColorContext, SvgClassContext } from '../ui/internal/host'

export type IconSvgElement = readonly (readonly [
  string,
  { readonly [key: string]: string | number }
])[]

export interface HugeiconsIconProps {
  icon: IconSvgElement
  altIcon?: IconSvgElement
  showAlt?: boolean
  size?: number | string
  strokeWidth?: number
  absoluteStrokeWidth?: boolean
  color?: string
  primaryColor?: string
  className?: string
  style?: StyleDesc
  'aria-label'?: string
  'data-testid'?: string
}

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

const sourceCache = new Map<IconSvgElement, Map<string, string>>()

/** SVG markup for `icon` with every paint black, as GPUIX's tinted renderer expects. */
export function iconSource(icon: IconSvgElement, strokeWidth: number | undefined): string {
  let bySize = sourceCache.get(icon)
  if (!bySize) {
    bySize = new Map()
    sourceCache.set(icon, bySize)
  }
  const key = String(strokeWidth)
  const cached = bySize.get(key)
  if (cached) return cached
  const body = icon
    .map(([tag, attrs]) => {
      const out: string[] = []
      for (const [name, raw] of Object.entries(attrs)) {
        if (name === 'key') continue
        if (strokeWidth !== undefined && (name === 'strokeWidth' || name === 'stroke')) continue
        let value = String(raw)
        if ((name === 'stroke' || name === 'fill') && value !== 'none') value = '#000'
        out.push(`${kebab(name)}="${escapeAttr(value)}"`)
      }
      if (strokeWidth !== undefined) out.push(`stroke-width="${strokeWidth}"`, 'stroke="#000"')
      return `<${tag} ${out.join(' ')}/>`
    })
    .join('')
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none">${body}</svg>`
  bySize.set(key, source)
  return source
}

function px(value: number | string): number {
  return typeof value === 'number' ? value : Number.parseFloat(value)
}

/** Width, height and paint for an icon: `[&_svg]` classes beat its own classes, which beat `size`. */
export function useIconStyle(
  size: number | string,
  className: string | undefined,
  color: string | undefined,
  style: StyleDesc | undefined
): StyleDesc {
  const inherited = useContext(CurrentColorContext)
  const descendant = useContext(SvgClassContext)
  const own = className ? tw(className) : {}
  const forced = descendant ? tw(descendant) : {}
  const side = px(size)
  const explicitColor = color && color !== 'currentColor' ? color : undefined
  return {
    width: side,
    height: side,
    flexShrink: 0,
    ...own,
    ...forced,
    color: own.color ?? explicitColor ?? inherited ?? tw('text-foreground').color,
    ...style
  }
}

export const HugeiconsIcon = forwardRef<PublicInstance, HugeiconsIconProps>(function HugeiconsIcon(
  {
    icon,
    altIcon,
    showAlt = false,
    size = 24,
    strokeWidth,
    absoluteStrokeWidth = false,
    color = 'currentColor',
    primaryColor,
    className,
    style,
    'aria-label': ariaLabel,
    'data-testid': testId
  },
  ref
) {
  const current = showAlt && altIcon ? altIcon : icon
  const stroke =
    strokeWidth !== undefined && absoluteStrokeWidth ? (strokeWidth * 24) / px(size) : strokeWidth
  const resolved = useIconStyle(size, className, primaryColor ?? color, style)
  return (
    <svg
      ref={ref as Ref<PublicInstance>}
      source={iconSource(current, stroke)}
      style={resolved}
      testId={testId}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
    />
  )
})
