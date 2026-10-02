import { TermulMark } from '@/components/TermulMark'
import { cn } from '@/lib/utils'

/**
 * Launcher hero: the mark + project-scoped prompt. On the mobile web shell it
 * shrinks (smaller mark + tighter margins) so the bottom-anchored composer
 * stays above the fold; during a launch exit it dissolves upward.
 */
export function LauncherHero({
  isMobileShell,
  isExiting,
  reducedMotion,
  projectLabel
}: {
  isMobileShell: boolean
  isExiting: boolean
  reducedMotion: boolean
  projectLabel: string
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'mb-8 flex w-full flex-col items-center gap-4 text-center transition-[opacity,translate,filter] duration-200 ease-out motion-reduce:transition-none',
        isMobileShell && 'mb-4 gap-2',
        isExiting && !reducedMotion && '-translate-y-2 opacity-0 blur-[2px]'
      )}
    >
      <TermulMark size={isMobileShell ? 32 : 48} className="text-foreground" />
      <h1
        className={cn(
          'break-words text-3xl font-medium tracking-tight text-foreground md:text-4xl',
          isMobileShell && 'text-xl'
        )}
      >
        {`What should we do in ${projectLabel}?`}
      </h1>
    </div>
  )
}
