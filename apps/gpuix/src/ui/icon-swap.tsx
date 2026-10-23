import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Box } from './internal/host'

interface IconSwapProps {
  iconKey: string | number | boolean
  children: ReactNode
  className?: string
}

/** Swaps icon states by key. The web cross-fade is a framer-motion presence; GPUIX swaps at once, as under reduced motion. */
export function IconSwap({ iconKey, children, className }: IconSwapProps) {
  return (
    <Box
      key={String(iconKey)}
      className={cn('inline-flex size-3.5 shrink-0 items-center justify-center', className)}
    >
      {children}
    </Box>
  )
}
