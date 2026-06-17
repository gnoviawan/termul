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
 * type. We only swallow drags that carry OS files, leaving internal DnD intact.
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
      // Required so the subsequent `drop` event fires and so the cursor shows
      // a "no drop" affordance instead of the default "open" behavior.
      event.preventDefault()
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'none'
      }
    }

    const handleDrop = (event: DragEvent): void => {
      if (!hasExternalFiles(event)) return
      // Stop the WebView from navigating to / rendering the dropped file.
      event.preventDefault()
      event.stopPropagation()
    }

    window.addEventListener('dragover', handleDragOver, { capture: true })
    window.addEventListener('drop', handleDrop, { capture: true })

    return () => {
      window.removeEventListener('dragover', handleDragOver, { capture: true })
      window.removeEventListener('drop', handleDrop, { capture: true })
    }
  }, [])
}
