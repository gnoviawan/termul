import { create } from 'zustand'

/** "Not now" hides a suggestion on this device for a day. */
export const SNOOZE_MS = 24 * 60 * 60 * 1000
const STORAGE_KEY = 'termul.automation-suggestion-snoozes'

type Snoozes = Record<string, number>

function load(): Snoozes {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    if (typeof parsed !== 'object' || parsed === null) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number'
      )
    )
  } catch {
    return {}
  }
}

interface SnoozeState {
  /** Fingerprint to the time its snooze ends. */
  until: Snoozes
  snooze: (fingerprint: string, now?: number) => void
}

export const useSuggestionSnoozes = create<SnoozeState>((set) => ({
  until: load(),
  snooze: (fingerprint, now = Date.now()) =>
    set((state) => {
      const until = Object.fromEntries(Object.entries(state.until).filter(([, end]) => end > now))
      until[fingerprint] = now + SNOOZE_MS
      try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(until))
      } catch {
        // Storage full or blocked: the snooze still holds for this session.
      }
      return { until }
    })
}))

export function isSnoozed(until: Snoozes, fingerprint: string, now = Date.now()): boolean {
  return (until[fingerprint] ?? 0) > now
}
