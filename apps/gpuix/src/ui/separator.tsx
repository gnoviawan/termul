import type { PublicInstance } from '@gpuix/react'
import { forwardRef } from 'react'
import { cn } from '@/lib/utils'
import { Box, type HostProps } from './internal/host'

export interface SeparatorProps extends HostProps {
  orientation?: 'horizontal' | 'vertical'
  decorative?: boolean
}

const Separator = forwardRef<PublicInstance, SeparatorProps>(
  ({ className, orientation = 'horizontal', decorative = true, ...props }, ref) => (
    <Box
      ref={ref}
      role={decorative ? undefined : 'separator'}
      data-orientation={orientation}
      className={cn(
        'shrink-0 bg-border',
        orientation === 'horizontal' ? 'h-[1px] w-full' : 'h-full w-[1px]',
        className
      )}
      {...props}
    />
  )
)
Separator.displayName = 'Separator'

export { Separator }
