import type { Edge, NodeId, NodeKind, NodePosition, Port } from '@shared/types/automation.types'
import { createContext, useContext } from 'react'
import type { ConnectRefusal } from '../draft/apply-op'
import type { AddPlacement } from '../draft/gestures'

/** A new step to pick: where it goes, and the viewport point the menu opens at. */
export type AddRequest = AddPlacement & { screen: { x: number; y: number } }

/** The port an edge is being drawn from; `tap` when it waits for a tap on the target. */
export type ConnectFrom = { from: Edge['from']; port: Edge['port']; tap: boolean }

/** What the canvas asks of the editor in edit mode. No React Flow types cross it. */
export interface FlowEdit {
  connect: (edge: Edge) => void
  refused: (reason: ConnectRefusal) => void
  /** Cards that finished moving, with their new top-left corners. */
  move: (positions: Record<string, NodePosition>) => void
  remove: (nodes: NodeId[], edges: Edge[]) => void
  requestAdd: (request: AddRequest) => void
  /** A palette row dropped on the canvas. */
  drop: (kind: NodeKind, at: NodePosition) => void
  undo: () => void
  redo: () => void
  /** Save is running: the canvas takes no edits until it answers. */
  locked: boolean
  canUndo: boolean
  canRedo: boolean
}

type ScreenPoint = { x: number; y: number }

export const FlowEditContext = createContext<{
  editing: boolean
  connecting: ConnectFrom | null
  canTake: (to: string) => boolean
  /** The dangling "+" on an open output. */
  addFrom: (from: Edge['from'], port: Port, screen: ScreenPoint) => void
  /** The "+" on an edge: a new step in its middle. */
  insertOn: (edge: Edge, at: NodePosition, screen: ScreenPoint) => void
  hoveredEdge: string | null
  hoverEdge: (id: string | null) => void
}>({
  editing: false,
  connecting: null,
  canTake: () => false,
  addFrom: () => {},
  insertOn: () => {},
  hoveredEdge: null,
  hoverEdge: () => {}
})

export function useFlowEdit() {
  return useContext(FlowEditContext)
}
