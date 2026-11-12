/**
 * Format an epoch-millisecond timestamp as a compact relative time, e.g.
 * "now", "5m", "3h", "2d", "5w". Falls back to a short localized date for
 * anything older than ~8 weeks. A non-finite timestamp yields an empty string
 * so the UI can render nothing rather than "Invalid Date".
 *
 * `now` is injectable for deterministic tests. This is the number-based core
 * shared by commit rows (ISO via `formatRelativeTime`) and chat-history rows
 * (epoch-ms `lastActivityAt`).
 */
export function formatRelativeTimeFromMs(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms)) return ''

  const diffMs = now - ms
  // Future timestamps (clock skew) clamp to "now" rather than negative values.
  const seconds = Math.max(0, Math.floor(diffMs / 1000))

  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  if (weeks < 8) return `${weeks}w`

  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

/**
 * Format an ISO 8601 timestamp as a compact relative time for commit rows.
 * Delegates to `formatRelativeTimeFromMs` after parsing; invalid input yields
 * an empty string. `now` is injectable for deterministic tests.
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  return formatRelativeTimeFromMs(then, now)
}

/** Local midnight at the start of `now`'s day, in epoch ms. */
export function startOfToday(now: number): number {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

/**
 * Local midnight at the start of the day before `now`'s, in epoch ms. Steps
 * the calendar day rather than subtracting 24 h, so the boundary holds the day
 * after a DST change (a 23 h or 25 h day).
 */
export function startOfYesterday(now: number): number {
  const day = new Date(startOfToday(now))
  day.setDate(day.getDate() - 1)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

/**
 * Format when a chat was created for the mobile Recents rows: the locale clock
 * time (e.g. "14:05") for today, "Yesterday 14:05" for yesterday, else a short
 * date ("Oct 28"), with the year when it is not this year. Yesterday names the
 * day because the Active and Unassigned sections have no date heading. A
 * missing, zero or non-finite timestamp yields an empty string so the row
 * shows no time.
 *
 * The day boundaries match `groupSessionsByRecency`. `now` is injectable for
 * deterministic tests.
 */
export function formatChatCreatedTime(ms: number | undefined, now: number = Date.now()): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return ''
  const created = new Date(ms)
  const clock = created.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (ms >= startOfToday(now)) return clock
  if (ms >= startOfYesterday(now)) return `Yesterday ${clock}`
  const thisYear = created.getFullYear() === new Date(now).getFullYear()
  return created.toLocaleDateString(
    undefined,
    thisYear
      ? { month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric' }
  )
}

/**
 * Format when a chat was last active with its clock time on every day, for a
 * row that has no title to tell it apart: "Today, 14:05", "Yesterday, 09:10",
 * "Oct 28, 14:05" (with the year when it is not this year). A missing, zero or
 * non-finite timestamp yields an empty string.
 */
export function formatChatFullTime(ms: number | undefined, now: number = Date.now()): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return ''
  const created = new Date(ms)
  const clock = created.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (ms >= startOfToday(now)) return `Today, ${clock}`
  if (ms >= startOfYesterday(now)) return `Yesterday, ${clock}`
  const thisYear = created.getFullYear() === new Date(now).getFullYear()
  const date = created.toLocaleDateString(
    undefined,
    thisYear
      ? { month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric' }
  )
  return `${date}, ${clock}`
}

/**
 * Format when a titled chat was last active, short enough to leave its title
 * room on a phone: "Just now", "9m ago", "3h ago" for today, "Yesterday", then
 * a short date ("Nov 8", with the year when it is not this year). A missing,
 * zero or non-finite timestamp yields an empty string.
 */
export function formatChatShortTime(ms: number | undefined, now: number = Date.now()): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return ''
  if (ms >= startOfToday(now)) {
    const minutes = Math.max(0, Math.floor((now - ms) / 60_000))
    if (minutes < 1) return 'Just now'
    if (minutes < 60) return `${minutes}m ago`
    return `${Math.floor(minutes / 60)}h ago`
  }
  if (ms >= startOfYesterday(now)) return 'Yesterday'
  const date = new Date(ms)
  return date.toLocaleDateString(
    undefined,
    date.getFullYear() === new Date(now).getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric' }
  )
}
