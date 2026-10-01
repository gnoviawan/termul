import { useEffect } from 'react'

/**
 * Guard against the WebView navigating away when an external OS file is dropped
 * onto the window.
 *
 * The Tauri window runs with `dragDropEnabled: false` (see
 * `src-tauri/tauri.conf.json`), so native drag/drop events are forwarded
 * straight to the WebView. The WebView's default behavior for a dropped file is
 * to navigate to it — e.g. dropping a PDF makes WKWebView render the PDF
 * full-screen, replacing the entire React app with no way back (issue: dropping
 * a file locks the UI and forces a restart).
 *
 * Internal drag-and-drop (tab/file reordering via `use-pane-dnd`) uses custom
 * JSON payloads on `dataTransfer`, not OS files, so it never sets the `Files`
 * type. Feature drop zones that handle an OS-file drop themselves (composers)
 * mark it via `preventDefault`, which this guard honors — only unhandled
 * OS-file drops are swallowed here.
 */
function hasExternalFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types
  if (!types) return false
  // `types` is a DOMStringList in some engines and a string[] in others;
  // both support iteration via Array.from.
  return Array.from(types).includes('Files')
}

export function usePreventFileDropNavigation(): void {
  useEffect(() => {
    const handleDragOver = (event: DragEvent): void => {
      if (!hasExternalFiles(event)) return
      // A feature drop zone (e.g. a composer attachment target) already opted
      // in by calling `preventDefault()` on its own `dragover` — leave its
      // drop affordance alone instead of forcing the "no drop" cursor over it.
      if (event.defaultPrevented) return
      // Required so the subsequent `drop` event fires and so the cursor shows
      // a "no drop" affordance instead of the default "open" behavior.
      event.preventDefault()
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'none'
      }
    }

    const handleDrop = (event: DragEvent): void => {
      if (!hasExternalFiles(event)) return
      // A feature drop zone handled the drop (its `preventDefault` already
      // ran) — never swallow it by stopping propagation.
      if (event.defaultPrevented) return
      // Stop the WebView from navigating to / rendering the dropped file.
      event.preventDefault()
    }

    // Bubble phase (not capture): feature drop zones run their handlers first
    // (the React root container sits below window), and this guard only
    // backstops events nothing handled. Capture + `stopPropagation` would
    // swallow every app drop zone — composer drag-drop never fired.
    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('drop', handleDrop)

    return () => {
      window.removeEventListener('dragover', handleDragOver)
      window.removeEventListener('drop', handleDrop)
    }
  }, [])
}
