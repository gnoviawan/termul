import { cn } from '@/lib/utils'
import { Box, type HostProps } from './internal/host'

/** `animate-pulse` has no GPUIX keyframes; the block paints at rest, as under reduced motion. */
function Skeleton({ className, ...props }: HostProps) {
  return <Box className={cn('rounded-md bg-muted', className)} {...props} />
}

export { Skeleton }
