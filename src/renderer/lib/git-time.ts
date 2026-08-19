import { i18n } from '@/i18n'
import { formatDate, formatNumber } from '@/i18n/format'

/**
 * Format an ISO 8601 timestamp as a compact relative time for commit rows,
 * e.g. "now", "5m", "3h", "2d", "5w". Falls back to a short localized date for
 * anything older than ~8 weeks. Invalid input yields an empty string so the UI
 * can render nothing rather than "Invalid Date".
 *
 * `now` is injectable for deterministic tests.
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''

  const diffMs = now - then
  // Future timestamps (clock skew) clamp to "now" rather than negative values.
  const seconds = Math.max(0, Math.floor(diffMs / 1000))

  if (seconds < 60) {
    return i18n.t('time.now', { ns: 'git', defaultValue: 'now' })
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return i18n.t('time.minutes', {
      ns: 'git',
      count: minutes,
      formattedCount: formatNumber(minutes),
      defaultValue: '{{formattedCount}}m'
    })
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return i18n.t('time.hours', {
      ns: 'git',
      count: hours,
      formattedCount: formatNumber(hours),
      defaultValue: '{{formattedCount}}h'
    })
  }
  const days = Math.floor(hours / 24)
  if (days < 7) {
    return i18n.t('time.days', {
      ns: 'git',
      count: days,
      formattedCount: formatNumber(days),
      defaultValue: '{{formattedCount}}d'
    })
  }
  const weeks = Math.floor(days / 7)
  if (weeks < 8) {
    return i18n.t('time.weeks', {
      ns: 'git',
      count: weeks,
      formattedCount: formatNumber(weeks),
      defaultValue: '{{formattedCount}}w'
    })
  }

  return formatDate(then, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}
