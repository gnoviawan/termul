import { type ReactNode, useEffect, useState } from 'react'
import { COLOR_THEME_CHANGED_EVENT } from '@/lib/themes'
import { getLastAppliedColorThemeId } from '@/lib/themes/apply-color-theme'
import { cn } from '@/lib/utils'

/** Preview body padding and rhythm. */
export function Pad({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-col gap-5 p-5', className)}>{children}</div>
}

/** A labeled row: a short mono label and the specimens beside it. */
export function Row({
  label,
  children,
  className
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className="flex items-start gap-4">
      <span className="w-24 shrink-0 pt-1.5 font-mono text-xs text-muted-foreground">{label}</span>
      <div className={cn('flex min-w-0 flex-1 flex-wrap items-center gap-3', className)}>
        {children}
      </div>
    </div>
  )
}

export function Caption({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>
}

/** Re-render whenever the global theme changes; returns the active theme id. */
export function useThemeId(): string {
  const [themeId, setThemeId] = useState(getLastAppliedColorThemeId)
  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{ themeId: string }>).detail
      setThemeId(detail?.themeId ?? getLastAppliedColorThemeId())
    }
    window.addEventListener(COLOR_THEME_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(COLOR_THEME_CHANGED_EVENT, onChange)
  }, [])
  return themeId
}

/** Read live computed values for CSS custom properties, refreshed on theme change. */
export function useCssVars(names: readonly string[]): Record<string, string> {
  const themeId = useThemeId()
  const [values, setValues] = useState<Record<string, string>>({})
  // biome-ignore lint/correctness/useExhaustiveDependencies: themeId is the refresh trigger.
  useEffect(() => {
    const style = getComputedStyle(document.documentElement)
    const next: Record<string, string> = {}
    for (const name of names) {
      next[name] =
        document.documentElement.style.getPropertyValue(name).trim() ||
        style.getPropertyValue(name).trim()
    }
    setValues(next)
  }, [names, themeId])
  return values
}
