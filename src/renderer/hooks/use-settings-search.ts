import { defaultFilter } from 'cmdk'
import { useCallback, useEffect, useState } from 'react'

export interface SettingsSearchEntry {
  label: string
  description?: string
  keywords?: string[]
}

const DEBOUNCE_MS = 120

function substringMatch(query: string, entry: SettingsSearchEntry): boolean {
  const haystack = [entry.label, entry.description ?? '', ...(entry.keywords ?? [])]
    .join(' ')
    .toLowerCase()
  return haystack.includes(query.toLowerCase())
}

function fuzzyMatch(query: string, entry: SettingsSearchEntry): boolean {
  const keywords = [
    ...(entry.keywords ?? []),
    ...(entry.description ? [entry.description] : [])
  ]
  return defaultFilter(entry.label, query, keywords) > 0
}

export function useSettingsSearch() {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query)
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  const isSearching = debouncedQuery.trim().length > 0

  const clear = useCallback(() => {
    setQuery('')
  }, [])

  const matches = useCallback(
    (entry: SettingsSearchEntry): boolean => {
      if (!isSearching) {
        return true
      }

      const trimmed = debouncedQuery.trim()
      try {
        return fuzzyMatch(trimmed, entry)
      } catch {
        return substringMatch(trimmed, entry)
      }
    },
    [debouncedQuery, isSearching]
  )

  return {
    query,
    debouncedQuery,
    isSearching,
    setQuery,
    clear,
    matches
  }
}
