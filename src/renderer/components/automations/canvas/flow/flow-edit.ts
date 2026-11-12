import type { Edge, NodeId, NodePosition } from '@shared/types/automation.types'
import { createContext, useContext } from 'react'
import type { ConnectRefusal } from '../draft/apply-op'

/** The port an edge is being drawn from; `tap` when it waits for a tap on the target. */
export type ConnectFrom = { from: Edge['from']; port: Edge['port']; tap: boolean }

/** What the canvas asks of the editor in edit mode. No React Flow types cross it. */
export interface FlowEdit {
  connect: (edge: Edge) => void
  refused: (reason: ConnectRefusal) => void
  /** Cards that finished moving, with their new top-left corners. */
  move: (positions: Record<string, NodePosition>) => void
  remove: (nodes: NodeId[], edges: Edge[]) => void
  undo: () => void
  redo: () => void
  /** Save is running: the canvas takes no edits until it answers. */
  locked: boolean
  canUndo: boolean
  canRedo: boolean
}

export const FlowEditContext = createContext<{
  editing: boolean
  connecting: ConnectFrom | null
  canTake: (to: string) => boolean
}>({ editing: false, connecting: null, canTake: () => false })

export function useFlowEdit() {
  return useContext(FlowEditContext)
}
