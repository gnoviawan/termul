/**
 * GPUIX answers a synchronous read only when the GPUI UI thread gets to it,
 * and throws once it has waited 2 s (`recv_ui_response`). Compat reads the
 * focused element inside key handlers and for `document.activeElement`, so
 * under a heavy frame load that throw escaped a native event dispatch and the
 * runtime-error overlay replaced the app (F3's 8-chat stream-storm). Not
 * knowing the focused element for one keystroke is the lesser failure: the
 * key handler falls back to its own element, `activeElement` to `body`.
 */

const UI_TIMEOUT = /^Timed out after \d+ seconds? waiting for the /

export function isUiTimeout(err: unknown): boolean {
  return err instanceof Error && UI_TIMEOUT.test(err.message)
}

export interface FocusReader {
  getFocusedElementId(): number | null
}

export function tolerateBusyFocusReads(renderer: FocusReader): () => void {
  const read = renderer.getFocusedElementId
  const tolerant = () => {
    try {
      return read.call(renderer)
    } catch (err) {
      if (isUiTimeout(err)) return null
      throw err
    }
  }
  renderer.getFocusedElementId = tolerant
  return () => {
    if (renderer.getFocusedElementId === tolerant) renderer.getFocusedElementId = read
  }
}
