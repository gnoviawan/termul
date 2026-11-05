/**
 * The canvas store's `loading`-phase watchdog (#1490). A mount whose iframe
 * never posts `event.ready` (its navigation was cancelled, or the bundle
 * never ran) would otherwise show "Loading editor…" forever with nothing
 * logged. One timer per project, for the mount it was armed for; arming
 * again replaces it.
 */

/** Generous for a cold wasm start on a slow machine; the bundle is served
 * from the local loopback listener, so a healthy mount is far quicker. */
export const CANVAS_LOAD_TIMEOUT_MS = 60_000

const watchdogs = new Map<string, { mountSeq: number; timer: ReturnType<typeof setTimeout> }>()

export function armLoadWatchdog(
  projectId: string,
  mountSeq: number,
  onTimeout: (projectId: string, mountSeq: number) => void
): void {
  clearLoadWatchdog(projectId)
  const timer = setTimeout(() => {
    if (watchdogs.get(projectId)?.timer !== timer) return
    watchdogs.delete(projectId)
    onTimeout(projectId, mountSeq)
  }, CANVAS_LOAD_TIMEOUT_MS)
  watchdogs.set(projectId, { mountSeq, timer })
}

/** Stops the project's watchdog; with `mountSeq`, only if it watches that
 * mount. */
export function clearLoadWatchdog(projectId: string, mountSeq?: number): void {
  const entry = watchdogs.get(projectId)
  if (!entry || (mountSeq !== undefined && entry.mountSeq !== mountSeq)) return
  clearTimeout(entry.timer)
  watchdogs.delete(projectId)
}
