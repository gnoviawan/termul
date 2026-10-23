import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Box } from './internal/host'

/** Hairline key chip look (web `KBD_CLASS`; tools/ui drift test keeps them equal). */
export const KBD_CLASS =
  'rounded border border-border font-sans text-3xs font-medium text-muted-foreground'

/** Keyboard key chip (for example "Ctrl+1" or "Esc"). `<kbd>` is inline-block text. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <Box className={cn('flex items-center', KBD_CLASS, className)}>{children}</Box>
}
