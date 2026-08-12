/**
 * Suppress the native browser/webview context menu app-wide (capture phase).
 *
 * `preventDefault()` on the capture-phase `contextmenu` event prevents the
 * native menu (Inspect, Back, etc.) from showing on portaled overlays (toasts,
 * modals) that live outside the Radix `<GlobalContextMenu>` trigger subtree.
 * It does NOT stop propagation, so the Radix trigger still opens the global
 * menu for right-clicks inside its subtree, and custom menus
 * (FileExplorer/ProjectSidebar) still render their own UI.
 *
 * P4 defense-in-depth alongside `<GlobalContextMenu>` — the Radix trigger's
 * own `preventDefault` only covers its subtree; this hook covers the rest of
 * the document (portals, blank areas). Mounted on BOTH surfaces (TauriApp +
 * App) for parity.
 */

import { useEffect } from 'react'

export function usePreventNativeContextMenu(): void {
  useEffect(() => {
    if (typeof document === 'undefined') return

    const handler = (e: MouseEvent): void => {
      e.preventDefault()
    }

    document.addEventListener('contextmenu', handler, { capture: true })
    return () => document.removeEventListener('contextmenu', handler, { capture: true })
  }, [])
}
