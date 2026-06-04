import { useCallback, useEffect, useRef } from 'react'
import { persistenceApi } from '@/lib/api'
import { useTerminalProfilesStore } from '@/stores/terminal-profiles-store'
import type { TerminalProfile } from '@/types/terminal-profile'
import { TERMINAL_PROFILES_KEY } from '@/types/terminal-profile'

/**
 * Load terminal profiles from persistence on mount
 */
export function useTerminalProfilesLoader(): void {
  const setProfiles = useTerminalProfilesStore((state) => state.setProfiles)

  useEffect(() => {
    let mounted = true

    async function load() {
      try {
        const result = await persistenceApi.read<TerminalProfile[]>(TERMINAL_PROFILES_KEY)
        if (result.success && mounted) {
          setProfiles(result.data ?? [])
        } else if (!result.success) {
          console.warn('[TerminalProfiles] Failed to load profiles:', result.error)
          if (mounted) {
            setProfiles([])
          }
        }
      } catch (error) {
        console.error('[TerminalProfiles] Load error:', error)
        if (mounted) {
          setProfiles([])
        }
      }
    }

    load()

    return () => {
      mounted = false
    }
  }, [setProfiles])
}

/**
 * Auto-save terminal profiles when they change
 */
export function useTerminalProfilesAutoSave(): void {
  const profiles = useTerminalProfilesStore((state) => state.profiles)
  const isLoaded = useTerminalProfilesStore((state) => state.isLoaded)
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previousProfilesRef = useRef<string>('')

  const saveProfiles = useCallback(async (profilesToSave: TerminalProfile[]) => {
    try {
      const result = await persistenceApi.write(TERMINAL_PROFILES_KEY, profilesToSave)
      if (!result.success) {
        console.warn('[TerminalProfiles] Failed to save profiles:', result.error)
      }
    } catch (error) {
      console.error('[TerminalProfiles] Save error:', error)
    }
  }, [])

  useEffect(() => {
    // Don't save until initial load is complete
    if (!isLoaded) {
      return
    }

    const serialized = JSON.stringify(profiles)

    // Skip if unchanged
    if (serialized === previousProfilesRef.current) {
      return
    }

    previousProfilesRef.current = serialized

    // Debounce saves
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }

    saveTimeoutRef.current = setTimeout(() => {
      saveProfiles(profiles)
    }, 300)

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
    }
  }, [profiles, isLoaded, saveProfiles])
}
