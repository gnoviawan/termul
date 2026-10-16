import { useEffect, useState } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { useProjectSwitchStatus } from '@/lib/project-switch/status-store'

/** A switch that lands within this time shows nothing (no flicker). */
export const SWITCH_INDICATOR_DELAY_MS = 150

/**
 * Shows that a project switch is loading. The coordinator keeps the previous
 * project on screen until the new tree is ready, so a slow first visit needs a
 * visible sign that the pick was taken. Failures are reported by a toast.
 */
export function ProjectSwitchIndicator(): React.JSX.Element | null {
  const pendingProjectId = useProjectSwitchStatus((state) => state.pending?.projectId ?? null)
  const [visibleFor, setVisibleFor] = useState<string | null>(null)

  useEffect(() => {
    if (!pendingProjectId) {
      setVisibleFor(null)
      return
    }
    const timer = setTimeout(() => setVisibleFor(pendingProjectId), SWITCH_INDICATOR_DELAY_MS)
    return () => clearTimeout(timer)
  }, [pendingProjectId])

  if (!pendingProjectId || visibleFor !== pendingProjectId) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-sm"
    >
      <Spinner size={12} decorative />
      Switching project…
    </div>
  )
}
