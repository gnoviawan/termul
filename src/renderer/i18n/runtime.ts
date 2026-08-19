import i18n from 'i18next'
import type { Namespace } from './resources'

export type TranslationValues = Record<string, unknown>

type RuntimeTranslate = (key: string, options: Record<string, unknown>) => string

function interpolateFallback(template: string, values?: TranslationValues): string {
  if (!values) return template
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key: string) => String(values[key] ?? ''))
}

/** Translate from non-React modules while preserving deterministic test fallbacks. */
export function runtimeT(
  namespace: Namespace,
  key: string,
  fallback: string,
  values?: TranslationValues
): string {
  if (!i18n.isInitialized) return interpolateFallback(fallback, values)

  // This boundary intentionally supports runtime keys supplied by ACP metadata.
  const translate = i18n.t.bind(i18n) as RuntimeTranslate
  return translate(key, { ns: namespace, defaultValue: fallback, ...values })
}
