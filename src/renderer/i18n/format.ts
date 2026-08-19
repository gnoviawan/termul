import { i18n } from './index'
import type { UiLanguage } from './language'

function currentLanguage(): UiLanguage {
  return i18n.resolvedLanguage === 'zh-CN' ? 'zh-CN' : 'en'
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(currentLanguage(), options).format(value)
}

export function formatCompactNumber(value: number): string {
  return formatNumber(value, { notation: 'compact', maximumFractionDigits: 1 })
}

export function formatCurrency(
  value: number,
  currency: string,
  options?: Omit<Intl.NumberFormatOptions, 'style' | 'currency'>
): string {
  return formatNumber(value, { ...options, style: 'currency', currency })
}

/** Parse a calendar date-only string (e.g. "2026-08-19") as a LOCAL date, so it
 * never shifts back a day in time zones west of UTC. `new Date('YYYY-MM-DD')`
 * treats the value as UTC midnight. */
function toDate(value: Date | number | string): Date {
  if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    if (match) {
      const [, year, month, day] = match
      return new Date(Number(year), Number(month) - 1, Number(day))
    }
  }
  return new Date(value)
}

export function formatDate(
  value: Date | number | string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }
): string {
  return new Intl.DateTimeFormat(currentLanguage(), options).format(toDate(value))
}

export function formatDateTime(value: Date | number | string): string {
  return formatDate(value, { dateStyle: 'medium', timeStyle: 'short' })
}

export function formatRelative(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  options?: Intl.RelativeTimeFormatOptions
): string {
  return new Intl.RelativeTimeFormat(currentLanguage(), options).format(value, unit)
}
