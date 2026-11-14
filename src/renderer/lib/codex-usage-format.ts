/**
 * Display helpers for Codex Account usage windows. Tone, reset time and the
 * usage bar come from the shared helpers the Claude rows already use.
 */

import type { ClaudeUsageWindow } from '@shared/types/claude-accounts.types'
import type { CodexAccountUsage, CodexUsageWindow } from '@shared/types/codex-accounts.types'
import {
  formatUsageChecked,
  formatUsageReset,
  type UsageReading,
  type UsageTone,
  usageTone
} from '@/lib/claude-usage-format'

export type { UsageReading, UsageTone }
export { formatUsageChecked, formatUsageReset, usageTone }

export const CODEX_USAGE_WARNING_PERCENT = 80

export function codexWindowLabel(window: CodexUsageWindow): string {
  return window.kind === 'weekly' ? 'Weekly' : '5-hour'
}

export function codexWindowShort(window: CodexUsageWindow): string {
  return window.kind === 'weekly' ? 'Wk' : '5h'
}

/** The window the bar shows first: the most used one that has not reset. */
export function primaryCodexWindow(
  usage: CodexAccountUsage | undefined,
  now = Date.now()
): CodexUsageWindow | null {
  if (usage?.status !== 'ok') return null
  return usage.windows.reduce<CodexUsageWindow | null>((top, window) => {
    const resetAt = codexResetSeconds(window)
    if (resetAt !== null && resetAt * 1000 <= now) return top
    return !top || window.percent > top.percent ? window : top
  }, null)
}

/** Shape the shared usage bar accepts. */
export function codexBarWindow(window: CodexUsageWindow): ClaudeUsageWindow {
  return {
    kind: window.kind === 'weekly' ? 'weekly_all' : 'session',
    group: window.kind === 'weekly' ? 'weekly' : 'session',
    scope: null,
    percent: window.percent,
    resetsAt: window.resetsAt,
    severity: null
  }
}

function reading(window: CodexUsageWindow): UsageReading {
  const percent = Math.round(window.percent)
  return {
    short: codexWindowShort(window),
    label: codexWindowLabel(window),
    percent,
    tone: usageTone(percent)
  }
}

/** The 5-hour window first, with the weekly window beside it when it is not calm. */
export function codexChipUsage(usage: CodexAccountUsage | undefined): {
  main: UsageReading
  other: UsageReading | null
} | null {
  if (usage?.status !== 'ok' || usage.windows.length === 0) return null
  const session = usage.windows.find((window) => window.kind === 'session')
  const weekly = usage.windows.find((window) => window.kind === 'weekly')
  const mainWindow = session ?? weekly ?? usage.windows[0]
  if (!mainWindow) return null
  const otherWindow = mainWindow === session ? weekly : null
  const other =
    otherWindow && usageTone(otherWindow.percent) !== 'normal' ? reading(otherWindow) : null
  return { main: reading(mainWindow), other }
}

/** Unix seconds of a window reset, for the live limit record. */
export function codexResetSeconds(window: CodexUsageWindow | null | undefined): number | null {
  if (!window?.resetsAt) return null
  const at = Date.parse(window.resetsAt)
  return Number.isNaN(at) ? null : Math.floor(at / 1000)
}

export function planLabel(planType: string | null): string | null {
  if (!planType) return null
  return planType.charAt(0).toUpperCase() + planType.slice(1)
}
