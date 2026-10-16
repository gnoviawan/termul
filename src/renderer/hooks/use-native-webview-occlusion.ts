import { useEffect, useSyncExternalStore } from 'react'
import { isTauriContext } from '@/lib/tauri-runtime'

/**
 * Native browser webviews paint above the DOM, so an overlay would be drawn
 * underneath them. The shared overlay primitives in `components/ui` register
 * here themselves; a custom fixed overlay calls `useNativeWebviewOcclusion`.
 * `useBrowserWebview` treats an occluded webview as not visible, so overlapping
 * overlays hide the webviews once and the last one to close reveals only the
 * webviews whose pane shows them.
 */

/**
 * `overlay` covers the interface (dialogs, menus, modal pickers), so DOM
 * surfaces under it are unreachable too. `docked` sits beside the interface
 * and only needs the webviews out of its way.
 */
export type NativeWebviewOccluderKind = 'overlay' | 'docked'

const occluderCounts: Record<NativeWebviewOccluderKind, number> = { overlay: 0, docked: 0 }
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function isOccluded(): boolean {
  return occluderCounts.overlay + occluderCounts.docked > 0
}

function isOverlayOpen(): boolean {
  return occluderCounts.overlay > 0
}

/** Registers the caller as an occluder while `open` is true. No-op outside Tauri. */
export function useNativeWebviewOcclusion(
  open: boolean,
  kind: NativeWebviewOccluderKind = 'overlay'
): void {
  useEffect(() => {
    if (!open || !isTauriContext()) return
    occluderCounts[kind] += 1
    emit()
    return () => {
      occluderCounts[kind] = Math.max(0, occluderCounts[kind] - 1)
      emit()
    }
  }, [open, kind])
}

/**
 * Rendered inside overlay content: Radix `Presence` keeps content mounted
 * through its exit animation, so mounted is the exact span the overlay is
 * visible.
 */
export function NativeWebviewOccluder(): null {
  useNativeWebviewOcclusion(true)
  return null
}

/** True while at least one occluder of either kind is open. */
export function useNativeWebviewOccluded(): boolean {
  return useSyncExternalStore(subscribe, isOccluded, isOccluded)
}

/** True while an `overlay` occluder covers the interface. */
export function useInterfaceOverlayOpen(): boolean {
  return useSyncExternalStore(subscribe, isOverlayOpen, isOverlayOpen)
}

/** @internal Test-only: drop every registered occluder. */
export function resetNativeWebviewOcclusionForTests(): void {
  occluderCounts.overlay = 0
  occluderCounts.docked = 0
  emit()
}
