import { useCallback } from 'react'
import type { TranslationValues } from '@/i18n/runtime'
import { useRuntimeTranslation } from '@/i18n/use-runtime-translation'

/** Runtime-key adapter for the SSH surface, whose catalog is independently maintained. */
export function useSshTranslation(): (key: string, values?: TranslationValues) => string {
  const translate = useRuntimeTranslation('ssh')
  return useCallback(
    (key: string, values?: TranslationValues) => translate(key, key, values),
    [translate]
  )
}
