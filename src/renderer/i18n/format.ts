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

export function formatDate(
  value: Date | number | string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }
): string {
  return new Intl.DateTimeFormat(currentLanguage(), options).format(new Date(value))
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
