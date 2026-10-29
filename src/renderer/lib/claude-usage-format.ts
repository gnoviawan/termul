/**
 * Display helpers for Claude Account usage windows (labels, reset times, and
 * the tone of a usage bar). Pure functions so every surface shows the same
 * words.
 */

import type {
  ClaudeAccountUsage,
  ClaudeRateLimit,
  ClaudeUsageWindow
} from '@shared/types/claude-accounts.types'

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

const mostUsed = (windows: ClaudeUsageWindow[]): ClaudeUsageWindow | null =>
  windows.reduce<ClaudeUsageWindow | null>(
    (top, window) => (!top || window.percent > top.percent ? window : top),
    null
  )

/** The window to show when there is room for one: the most used one. */
export function primaryUsageWindow(
  usage: ClaudeAccountUsage | undefined
): ClaudeUsageWindow | null {
  return usage?.status === 'ok' ? mostUsed(usage.windows) : null
}

/** One window as the account chip shows it: `5h 42%`, read out as "5-hour 42%". */
export interface UsageReading {
  short: string
  label: string
  percent: number
  tone: UsageTone
}

/** The 5-hour window, and the most used other window beside it. */
export interface FiveHourUsage {
  main: UsageReading
  /** `null` when there is no 5-hour window and `main` is the most used window instead. */
  other: UsageReading | null
}

/** Live `_claude/rateLimit` kinds as the usage windows they report on (as the host maps them). */
const LIVE_WINDOWS: Record<string, Pick<ClaudeUsageWindow, 'kind' | 'group' | 'scope'>> = {
  five_hour: { kind: 'session', group: 'session', scope: null },
  seven_day: { kind: 'weekly_all', group: 'weekly', scope: null },
  seven_day_opus: { kind: 'weekly_scoped', group: 'weekly', scope: 'Opus' },
  seven_day_sonnet: { kind: 'weekly_scoped', group: 'weekly', scope: 'Sonnet' }
}

function shortWindowLabel(window: ClaudeUsageWindow): string {
  if (window.kind === 'session') return '5h'
  if (window.group === 'weekly' || window.kind.startsWith('weekly')) return 'Wk'
  return usageWindowLabel(window)
}

function reading(window: ClaudeUsageWindow): UsageReading {
  const percent = Math.round(window.percent)
  return {
    short: shortWindowLabel(window),
    label: usageWindowLabel(window),
    percent,
    tone: usageTone(percent)
  }
}

/**
 * The 5-hour window first, since that is the one a user runs into, with the
 * most used other window beside it. The live limit is the freshest read of
 * its window, so it replaces that window's polled value.
 */
export function fiveHourUsage(
  usage: ClaudeAccountUsage | undefined,
  live: ClaudeRateLimit | null
): FiveHourUsage | null {
  const windows = usage?.status === 'ok' ? [...usage.windows] : []
  if (live?.percent != null) {
    const fresh: ClaudeUsageWindow = {
      kind: live.kind ?? 'usage',
      group: null,
      scope: null,
      ...(live.kind ? LIVE_WINDOWS[live.kind] : undefined),
      percent: live.percent,
      resetsAt: null,
      severity: null
    }
    const same = windows.findIndex((w) => w.kind === fresh.kind && w.scope === fresh.scope)
    if (same >= 0) windows[same] = fresh
    else windows.push(fresh)
  }
  const session = windows.find((w) => w.kind === 'session')
  if (!session) {
    const top = mostUsed(windows)
    return top && { main: reading(top), other: null }
  }
  const other = mostUsed(windows.filter((w) => w !== session))
  return { main: reading(session), other: other && reading(other) }
}

/** "Max", "Team" … from the SDK plan type. */
export function planLabel(subscriptionType: string | null): string | null {
  if (!subscriptionType) return null
  return subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1)
}
