import { cn } from '@/lib/utils'

/** Hairline key chip look. Padding and layout stay at the call site. */
export const KBD_CLASS =
  'rounded border border-border font-sans text-3xs font-medium text-muted-foreground'

/** Keyboard key chip (for example "Ctrl+1" or "Esc"). */
export function Kbd({
  children,
  className
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return <kbd className={cn(KBD_CLASS, className)}>{children}</kbd>
}
