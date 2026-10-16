/**
 * Display helpers for Claude Account usage windows (labels, reset times, and
 * the tone of a usage bar). Pure functions so every surface shows the same
 * words.
 */

import type { ClaudeAccountUsage, ClaudeUsageWindow } from '@shared/types/claude-accounts.types'

export type UsageTone = 'normal' | 'warning' | 'critical'

/** Percent at which a window shows the warning tone (the Limit warning). */
export const USAGE_WARNING_PERCENT = 80

export function usageTone(percent: number): UsageTone {
  if (percent >= 100) return 'critical'
  if (percent >= USAGE_WARNING_PERCENT) return 'warning'
  return 'normal'
}

export function usageWindowLabel(window: ClaudeUsageWindow): string {
  switch (window.kind) {
    case 'session':
      return '5-hour'
    case 'weekly_all':
      return 'Weekly'
    case 'weekly_scoped':
      return window.scope ? `Weekly · ${window.scope}` : 'Weekly'
    default: {
      const words = window.kind.replace(/_/g, ' ')
      return words.charAt(0).toUpperCase() + words.slice(1)
    }
  }
}

/**
 * "resets in 2h 14m" within a day, "resets in 3d" after that. `null` when the
 * window has not started or the time is not valid.
 */
export function formatUsageReset(
  resetsAt: string | number | null,
  now = Date.now()
): string | null {
  if (resetsAt === null) return null
  const at = typeof resetsAt === 'number' ? resetsAt * 1000 : Date.parse(resetsAt)
  if (!Number.isFinite(at)) return null
  const minutes = Math.max(0, Math.round((at - now) / 60_000))
  if (minutes < 1) return 'resets now'
  if (minutes < 60) return `resets in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest > 0 ? `resets in ${hours}h ${rest}m` : `resets in ${hours}h`
  }
  return `resets in ${Math.round(hours / 24)}d`
}

/** "Updated just now", "Updated 4m ago". */
export function formatUsageChecked(checkedAt: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - checkedAt) / 60_000)
  if (minutes < 1) return 'Updated just now'
  if (minutes < 60) return `Updated ${minutes}m ago`
  return `Updated ${Math.floor(minutes / 60)}h ago`
}

/** The window to show when there is room for one: the most used one. */
export function primaryUsageWindow(
  usage: ClaudeAccountUsage | undefined
): ClaudeUsageWindow | null {
  if (usage?.status !== 'ok' || usage.windows.length === 0) return null
  return usage.windows.reduce((top, window) => (window.percent > top.percent ? window : top))
}

/** "Max", "Team" … from the SDK plan type. */
export function planLabel(subscriptionType: string | null): string | null {
  if (!subscriptionType) return null
  return subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1)
}
