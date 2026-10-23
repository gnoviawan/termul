/**
 * The GPUIX twin of the web icon factory (`hugeIcon` in
 * src/renderer/components/icons/index.tsx): same props, same 1.5 default stroke.
 */
import type { PublicInstance, StyleDesc } from '@gpuix/react'
import { type ForwardRefExoticComponent, forwardRef, type Ref, type RefAttributes } from 'react'
import { HugeiconsIcon, type IconSvgElement, useIconStyle } from './hugeicons'

export interface TermulIconProps {
  size?: number | string
  strokeWidth?: number | string
  className?: string
  style?: StyleDesc
  color?: string
  fill?: string
  'aria-label'?: string
  'aria-hidden'?: boolean
  'data-testid'?: string
}

export type TermulIcon = ForwardRefExoticComponent<TermulIconProps & RefAttributes<PublicInstance>>

function strokeOf(strokeWidth: number | string | undefined): number {
  const requested = Number(strokeWidth ?? 1.5)
  return Number.isFinite(requested) ? requested : 1.5
}

export function hugeIcon(name: string, icon: IconSvgElement): TermulIcon {
  const Icon = forwardRef<PublicInstance, TermulIconProps>(function TermulIcon(
    {
      size = 24,
      strokeWidth,
      className,
      style,
      color,
      'aria-label': ariaLabel,
      'data-testid': testId
    },
    ref
  ) {
    return (
      <HugeiconsIcon
        ref={ref}
        icon={icon}
        size={size}
        strokeWidth={strokeOf(strokeWidth)}
        color={color}
        className={className}
        style={style}
        aria-label={ariaLabel}
        data-testid={testId}
      />
    )
  })
  Icon.displayName = name
  return Icon
}

/** The stop square, drawn in-app on the web too. `fill="currentColor"` fills it. */
export const Square: TermulIcon = forwardRef<PublicInstance, TermulIconProps>(function Square(
  { size = 24, strokeWidth, className, style, color, fill, 'aria-label': ariaLabel },
  ref
) {
  const stroke = strokeOf(strokeWidth)
  const paint = fill && fill !== 'none' ? 'fill="#000"' : 'fill="none"'
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${paint} stroke="#000" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="1"${stroke === 0 ? ' stroke="none"' : ''}/></svg>`
  const resolved = useIconStyle(size, className, color, style)
  return (
    <svg
      ref={ref as Ref<PublicInstance>}
      source={source}
      style={resolved}
      aria-label={ariaLabel}
      role={ariaLabel ? 'img' : undefined}
    />
  )
})
Square.displayName = 'Square'
