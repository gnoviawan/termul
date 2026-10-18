/**
 * Every mounted canvas's iframe, kept outside the tab tree (spine AD-19). A
 * mount lives from its first open until the host unmounts it, whatever
 * happens to its tab: closing the tab, switching tabs or projects, or moving
 * the tab to another pane only changes whether a visible `CanvasPanel` slot
 * exists, so the editor keeps its state and keeps answering agent calls.
 *
 * Rendered once by `WorkspaceLayout` (both renderer roots), beside either
 * shell, so a breakpoint change does not remount it either. It also hosts the
 * unsaved-canvas question of the unmount flow.
 */

import { basename } from '@/lib/path-basename'
import { useCanvasStore } from '@/stores/canvas-store'
import { CanvasShell } from './CanvasShell'
import { CanvasUnmountDialog } from './CanvasUnmountDialog'
import { useCanvasSlots } from './canvas-slots'

export function CanvasMountLayer(): React.JSX.Element {
  const sessions = useCanvasStore((state) => state.sessions)
  const slots = useCanvasSlots((state) => state.slots)

  return (
    <>
      {Object.values(sessions).map((session) => {
        const { phase } = session
        if (phase.kind !== 'loading' && phase.kind !== 'ready') return null
        return (
          <CanvasShell
            key={`${session.projectId}:${phase.mount.mountSeq}`}
            projectId={session.projectId}
            mount={phase.mount}
            title={`Canvas — ${basename(session.docPath)}`}
            slot={slots[session.projectId] ?? null}
          />
        )
      })}
      <CanvasUnmountDialog />
    </>
  )
}
