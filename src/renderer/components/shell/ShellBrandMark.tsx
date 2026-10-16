import { TermulMark } from '@/components/TermulMark'

/**
 * Termul mark at the start of the window top row. Brand only: not a button
 * and hidden from assistive technology. On desktop it is part of the window
 * drag region.
 */
export function ShellBrandMark({ dragRegion }: { dragRegion: boolean }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-testid="shell-brand-mark"
      data-tauri-drag-region={dragRegion ? true : undefined}
      className="inline-flex size-7 shrink-0 items-center justify-center text-foreground"
    >
      <TermulMark size={18} className="pointer-events-none" />
    </span>
  )
}
