import { useMemo } from 'react'
import {
  TERMUL_TOOLS,
  type TermulToolEntry,
  type TermulToolState
} from '@/lib/composer/termul-tools'
import { useCanvasStore } from '@/stores/canvas-store'

export interface TermulToolRow {
  tool: TermulToolEntry
  state: TermulToolState
}

/** The Termul tools the + menu and the + sheet offer, with each one's state in this project. */
export function useTermulTools(projectId: string | null): TermulToolRow[] {
  const canvasReady = useCanvasStore((s) =>
    projectId ? s.sessions[projectId]?.phase.kind === 'ready' : false
  )
  return useMemo(
    () => TERMUL_TOOLS.map((tool) => ({ tool, state: tool.state({ canvasReady }) })),
    [canvasReady]
  )
}
