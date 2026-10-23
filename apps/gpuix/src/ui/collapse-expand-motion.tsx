import { type ReactNode, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { Box } from './internal/host'

interface CollapseExpandMotionProps {
  open: boolean
  children: ReactNode
  className?: string
  onExitComplete?: () => void
  motion?: 'default' | 'chat'
}

/**
 * The web version animates `grid-template-rows` 0fr -> 1fr. GPUIX has no
 * fractional tracks to tween, so the content appears and leaves at once, as
 * under reduced motion, and `onExitComplete` fires after the close commits.
 * The one-column grid shell lays out as a flex column.
 */
export function CollapseExpandMotion({
  open,
  children,
  className,
  onExitComplete
}: CollapseExpandMotionProps) {
  const wasOpen = useRef(open)
  useEffect(() => {
    if (wasOpen.current && !open) onExitComplete?.()
    wasOpen.current = open
  }, [open, onExitComplete])
  if (!open) return null
  return (
    <Box className={cn('flex flex-col overflow-hidden', className)}>
      <Box className="min-h-0 overflow-hidden">{children}</Box>
    </Box>
  )
}
