import { create } from 'zustand'

/** "Not now" hides a suggestion of one project on this device for a day. */
export const SNOOZE_MS = 24 * 60 * 60 * 1000
const STORAGE_KEY = 'termul.automation-suggestion-snoozes'

type Snoozes = Record<string, number>

function snoozeKey(projectId: string, fingerprint: string): string {
  return `${projectId}:${fingerprint}`
}

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

function unexpired(until: Snoozes, now: number): Snoozes {
  return Object.fromEntries(Object.entries(until).filter(([, end]) => end > now))
}

interface SnoozeState {
  /** `projectId:fingerprint` to the time its snooze ends. */
  until: Snoozes
  snooze: (projectId: string, fingerprint: string, now?: number) => void
}

export const useSuggestionSnoozes = create<SnoozeState>((set) => ({
  until: load(),
  snooze: (projectId, fingerprint, now = Date.now()) =>
    set((state) => {
      const until = unexpired(state.until, now)
      until[snoozeKey(projectId, fingerprint)] = now + SNOOZE_MS
      try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(until))
      } catch {
        // Storage full or blocked: the snooze still holds for this session.
      }
      return { until }
    })
}))

export function isSnoozed(
  until: Snoozes,
  projectId: string,
  fingerprint: string,
  now = Date.now()
): boolean {
  return (until[snoozeKey(projectId, fingerprint)] ?? 0) > now
}

// A screen left open must show a suggestion again when its snooze ends, so
// the soonest end drops the expired snoozes and re-renders every reader.
let expiry: ReturnType<typeof setTimeout> | undefined
function scheduleExpiry(until: Snoozes): void {
  clearTimeout(expiry)
  const now = Date.now()
  const ends = Object.values(unexpired(until, now))
  if (ends.length === 0) return
  expiry = setTimeout(
    () => {
      const current = useSuggestionSnoozes.getState().until
      const kept = unexpired(current, Date.now())
      if (Object.keys(kept).length < Object.keys(current).length) {
        useSuggestionSnoozes.setState({ until: kept })
      } else {
        scheduleExpiry(current)
      }
    },
    Math.min(Math.min(...ends) - now, SNOOZE_MS)
  )
}
scheduleExpiry(useSuggestionSnoozes.getState().until)
useSuggestionSnoozes.subscribe((state) => scheduleExpiry(state.until))
