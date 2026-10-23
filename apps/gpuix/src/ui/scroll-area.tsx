import type { PublicInstance } from '@gpuix/react'
import { forwardRef } from 'react'
import { cn } from '@/lib/utils'
import { Box, type HostProps } from './internal/host'

/**
 * Radix ScrollArea: a clipped root with a scrolling viewport. GPUIX paints its
 * own thumb (not draggable, gpuix scrollbars), so ScrollBar renders nothing.
 * GPUIX does not nest vertical scrollers; keep one per column.
 */
const ScrollArea = forwardRef<
  PublicInstance,
  HostProps & { type?: string; scrollHideDelay?: number }
>(({ className, children, type: _type, scrollHideDelay: _delay, ...props }, ref) => (
  <Box ref={ref} {...props} className={cn('relative overflow-hidden', className)}>
    <Box className="h-full w-full rounded-[inherit]" style={{ overflowY: 'scroll' }}>
      {children}
    </Box>
  </Box>
))
ScrollArea.displayName = 'ScrollArea'

const ScrollBar = (_props: { orientation?: 'vertical' | 'horizontal'; className?: string }) => null

export { ScrollArea, ScrollBar }
