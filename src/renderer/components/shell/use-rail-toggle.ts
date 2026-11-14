import { useCallback } from 'react'
import { toast } from 'sonner'
import { useUpdatePanelVisibility } from '@/hooks/use-app-settings'
import { useSidebarVisible } from '@/stores/sidebar-store'
import { logRailEvent } from './rail/rail-log'

/** Accessible name of every control that expands or collapses the Rail. */
export const RAIL_TOGGLE_LABEL = 'Expand or collapse projects'

/**
 * Expands or collapses the Rail through the same persisted path as today's
 * sidebar toggle (`updatePanelVisibility('sidebarVisible', ...)`), with an
 * error toast when saving fails. Logs the toggle (`Rail` source) and a save
 * failure.
 */
export function useRailToggle(): { expanded: boolean; toggle: () => void } {
  const expanded = useSidebarVisible()
  const updatePanelVisibility = useUpdatePanelVisibility()

  const toggle = useCallback(() => {
    toggleRailVisibility(expanded, updatePanelVisibility, 'button')
  }, [expanded, updatePanelVisibility])

  return { expanded, toggle }
}

/**
 * Expands or collapses the Rail from `expanded` and logs it: the one path of
 * the Rail buttons and the keyboard shortcut (`via`).
 */
export function toggleRailVisibility(
  expanded: boolean,
  updatePanelVisibility: ReturnType<typeof useUpdatePanelVisibility>,
  via: 'button' | 'shortcut'
): void {
  const next = !expanded
  logRailEvent(`${next ? 'expand' : 'collapse'} rail (${via})`)
  void updatePanelVisibility('sidebarVisible', next).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Failed to update sidebar visibility'
    logRailEvent(`toggle rail failed: ${message}`, 'error')
    toast.error(message)
  })
}
