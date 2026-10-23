import { cn } from '@/lib/utils'
import { Box } from './internal/host'

/** The shimmer sweep is a CSS mask animation; GPUIX paints the label at rest. */
export function ShimmerText({ text, className }: { text: string; className?: string }) {
  return (
    <Box className={cn('flex', className)} data-text={text}>
      {text}
    </Box>
  )
}
