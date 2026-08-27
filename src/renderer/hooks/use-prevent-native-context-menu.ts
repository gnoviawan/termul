/**
 * Suppress the native browser/webview context menu app-wide (bubble phase).
 *
 * IMPORTANT: this listener MUST run in BUBBLE phase, not capture. Radix's
 * `ContextMenuTrigger` opens via `composeEventHandlers` (from
 * `@radix-ui/primitive`), which skips its `handleOpen` when
 * `event.defaultPrevented` is already true (`checkForDefaultPrevented`
 * defaults to true). A capture-phase `preventDefault()` here would fire
 * before Radix's bubble-phase trigger handler, set `defaultPrevented` early,
 * and suppress the global menu entirely — right-click would show nothing (no
 * native menu, no Radix menu). In bubble phase, Radix's root-level listener
 * fires first (opens the menu + its own `preventDefault`); this listener then
 * runs redundantly inside the trigger subtree, and is the active suppression
 * for portaled overlays outside it.
 *
 * P4 defense-in-depth alongside `<GlobalContextMenu>` — portals (toasts,
 * modals) rendered outside the Radix trigger subtree still bubble to
 * `document`, so their native menu is suppressed here. `preventDefault` does
 * NOT stop propagation, so innermost Radix triggers (the terminal's own
 * menu) still win via `defaultPrevented`, and custom menus
 * (FileExplorer/ProjectSidebar) still render. Mounted on BOTH surfaces
 * (TauriApp + App) for parity.
 */

import { useEffect } from 'react'

export function usePreventNativeContextMenu(): void {
  useEffect(() => {
    if (typeof document === 'undefined') return

    const handler = (e: MouseEvent): void => {
      e.preventDefault()
    }

    document.addEventListener('contextmenu', handler)
    return () => document.removeEventListener('contextmenu', handler)
  }, [])
}
