import type { VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'
import { badgeVariants } from '../../../../src/renderer/components/ui/badge-variants'
import { Box, type HostProps } from './internal/host'

export interface BadgeProps extends HostProps, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <Box className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
