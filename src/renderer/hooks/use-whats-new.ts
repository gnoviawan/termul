import { useCallback, useEffect, useRef, useState } from 'react'
import {
  compareVersions,
  fetchReleaseNotes,
  getCurrentAppVersion,
  getLastSeenVersion,
  setLastSeenVersion
} from '@/lib/tauri-release-notes'

interface WhatsNewState {
  isOpen: boolean
  version: string
  notes: string | null
  htmlUrl: string | null
}

const CLOSED_STATE: WhatsNewState = {
  isOpen: false,
  version: '',
  notes: null,
  htmlUrl: null
}

export interface UseWhatsNewResult {
  isOpen: boolean
  version: string
  notes: string | null
  htmlUrl: string | null
  close: () => void
}

/**
 * useWhatsNew Hook
 *
 * On mount, compares the running app version against the persisted last-seen
 * version. When the app was just updated to a newer version, it fetches that
 * version's GitHub release notes and opens a one-time "What's New" popup,
 * recording the version so it never re-shows.
 *
 * Behavior:
 * - Fresh install (no last-seen version): records current version, no popup.
 * - Same version or downgrade: no popup.
 * - Updated version: fetch notes, persist current version regardless of fetch
 *   outcome, and open the popup when a release record was resolved.
 */
export function useWhatsNew(): UseWhatsNewResult {
  const [state, setState] = useState<WhatsNewState>(CLOSED_STATE)
  const hasRunRef = useRef(false)

  useEffect(() => {
    if (hasRunRef.current) return
    hasRunRef.current = true

    const run = async (): Promise<void> => {
      try {
        const current = await getCurrentAppVersion()
        const lastSeen = await getLastSeenVersion()

        // Fresh install: record silently, never show on first launch.
        if (!lastSeen) {
          await setLastSeenVersion(current)
          return
        }

        // Same version or downgrade (e.g. dev builds): nothing to show.
        if (compareVersions(current, lastSeen) <= 0) {
          return
        }

        const release = await fetchReleaseNotes(current)

        // Mark seen regardless of fetch outcome so a flaky GitHub request does
        // not pin a stale popup on every launch.
        await setLastSeenVersion(current)

        if (release) {
          setState({
            isOpen: true,
            version: release.version,
            notes: release.notes,
            htmlUrl: release.htmlUrl
          })
        }
      } catch {
        // Never block startup or surface errors for this best-effort popup.
      }
    }

    void run()
  }, [])

  const close = useCallback(() => {
    setState(CLOSED_STATE)
  }, [])

  return {
    isOpen: state.isOpen,
    version: state.version,
    notes: state.notes,
    htmlUrl: state.htmlUrl,
    close
  }
}
