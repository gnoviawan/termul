/**
 * The canvas panel's two recovery strips, between its header and the editor:
 *
 * - the conflict choice (spine AD-27): the document changed on disk while
 *   the editor held unsaved work, autosave is stopped, and Troupe asks which
 *   version wins. A deleted document can only be kept (recreated).
 * - the crash notice (AD-31): the editor stopped working and was reloaded
 *   from the last save; it says how many unsaved changes that lost.
 *
 * Inline rather than modal: the iframe is laid over the area below, and the
 * user may want to look at their version before choosing.
 */

import type {
  CanvasConflict,
  CanvasConflictChoice,
  CanvasRemount
} from '@shared/types/canvas.types'
import { AlertTriangle, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { useCanvasStore } from '@/stores/canvas-store'

const CHOICES: { choice: CanvasConflictChoice; label: string; deleted: boolean }[] = [
  { choice: 'keepMine', label: 'Keep mine', deleted: true },
  { choice: 'takeDisk', label: 'Take disk', deleted: false },
  { choice: 'saveCopy', label: 'Save a copy', deleted: false }
]

export function CanvasConflictBar({
  projectId,
  conflict,
  resolving
}: {
  projectId: string
  conflict: CanvasConflict
  resolving: boolean
}): React.JSX.Element {
  const deleted = conflict.diskHash === null
  const message = deleted
    ? 'This document was deleted outside Troupe. Keep your version to recreate it.'
    : 'This document changed outside Troupe while you had unsaved changes. Autosave is paused.'
  return (
    <div
      role="alertdialog"
      aria-label="Canvas changed on disk"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2"
      data-testid="canvas-conflict"
    >
      <AlertTriangle size={14} className="shrink-0 text-warning" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-2xs text-foreground">{message}</span>
      <div className="flex shrink-0 items-center gap-2">
        {CHOICES.filter((option) => !deleted || option.deleted).map(({ choice, label }) => (
          <Button
            key={choice}
            size="xs"
            variant={choice === 'keepMine' ? 'default' : 'secondary'}
            disabled={resolving}
            onClick={() => void useCanvasStore.getState().resolveConflict(projectId, choice)}
          >
            {label}
          </Button>
        ))}
      </div>
    </div>
  )
}

function lostText(remount: CanvasRemount): string {
  const { lost } = remount
  if (!lost) return 'The canvas editor stopped responding and was reloaded from the last save.'
  const changes = lost.count === 1 ? '1 unsaved change' : `${lost.count} unsaved changes`
  const since = lost.sinceMs === null ? '' : ` since ${new Date(lost.sinceMs).toLocaleTimeString()}`
  const verb = lost.count === 1 ? 'was' : 'were'
  return `The canvas editor stopped responding and was reloaded from the last save. ${changes}${since} ${verb} lost.`
}

export function CanvasCrashNotice({
  projectId,
  remount
}: {
  projectId: string
  remount: CanvasRemount
}): React.JSX.Element {
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2"
      data-testid="canvas-crash-notice"
    >
      <AlertTriangle size={14} className="shrink-0 text-destructive" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-2xs text-foreground">{lostText(remount)}</span>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => useCanvasStore.getState().dismissCrash(projectId)}
        aria-label="Dismiss"
        title="Dismiss"
      >
        <X size={12} aria-hidden="true" />
      </Button>
    </div>
  )
}
