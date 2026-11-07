/**
 * Troupe's file watcher → the mounted canvases (spine AD-27). The same
 * `onFileChanged` / `onFileCreated` / `onFileDeleted` chain the explorer and
 * the code editor use, fed by notify on the desktop and by the host's `fs`
 * watch on the web, so detection is Troupe's and the editor never reads disk.
 *
 * An event for a mounted document asks the host what changed
 * (`checkDisk`); the host tells Troupe's own atomic writes apart by content
 * hash, so this side filters by path only. Events are debounced per project
 * because one save is several notify events (temp file, rename, modify).
 *
 * The watch covers the explorer's watched directories. A canvas outside them
 * (a hidden project) is checked when its panel is shown, and the host refuses
 * to overwrite a file that changed unseen.
 */

import type { FileChangeEvent } from '@shared/types/filesystem.types'
import { filesystemApi } from '@/lib/api'
import { useCanvasStore } from '@/stores/canvas-store'

const SETTLE_MS = 250

/** Watcher paths and doc paths differ in separators, and on Windows in the
 * drive letter's case. */
function comparablePath(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  return /^[A-Za-z]:/.test(slashed) ? slashed.toLowerCase() : slashed
}

export function startCanvasDiskWatch(): () => void {
  const pending = new Map<string, ReturnType<typeof setTimeout>>()

  const onChange = (event: FileChangeEvent): void => {
    const changed = comparablePath(event.path)
    for (const session of Object.values(useCanvasStore.getState().sessions)) {
      if (comparablePath(session.docPath) !== changed) continue
      const { projectId } = session
      clearTimeout(pending.get(projectId))
      pending.set(
        projectId,
        setTimeout(() => {
          pending.delete(projectId)
          void useCanvasStore.getState().checkDisk(projectId)
        }, SETTLE_MS)
      )
    }
  }

  const stops = [
    filesystemApi.onFileChanged(onChange),
    filesystemApi.onFileCreated(onChange),
    filesystemApi.onFileDeleted(onChange)
  ]
  return () => {
    for (const stop of stops) stop()
    for (const timer of pending.values()) clearTimeout(timer)
    pending.clear()
  }
}
