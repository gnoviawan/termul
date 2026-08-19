import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { Namespace } from './resources'
import { runtimeT, type TranslationValues } from './runtime'

export type RuntimeTranslator = (
  key: string,
  fallback: string,
  values?: TranslationValues
) => string

/** Namespace-scoped translator that also subscribes React components to language changes. */
export function useRuntimeTranslation(namespace: Namespace): RuntimeTranslator {
  useTranslation(namespace)
  return useCallback(
    (key, fallback, values) => runtimeT(namespace, key, fallback, values),
    [namespace]
  )
}
