import type { NodeKind, Port } from '@shared/types/automation.types'

export const TRIGGER = 'trigger'

/** A card's fixed size; edges attach to handles laid out against it. */
export const CARD = { width: 192, height: 64 } as const

/** Agent and MCP tool cards hang two config slots below the card. */
export const SLOT_DEPTH = 56

export function hasSlots(kind: NodeKind): boolean {
  return kind === 'agent' || kind === 'mcp_tool'
}

/** Legal output ports per kind (`graph.rs` `legal_ports`), top to bottom on the card. */
export const OUTPUT_PORTS: Record<NodeKind | typeof TRIGGER, readonly Port[]> = {
  trigger: ['out'],
  http: ['out', 'error'],
  agent: ['out', 'error'],
  transform: ['out', 'error'],
  approval: ['out', 'error'],
  mcp_tool: ['out', 'error'],
  condition: ['error', 'true', 'false'],
  for_each: ['error', 'out', 'item'],
  merge: ['out'],
  wait: ['out'],
  fail: []
}

/**
 * How a port reads. `spoken` is the screen-reader text; `label` says where
 * the port name is drawn: beside the handle, on the edge, or nowhere (`out`).
 */
export const PORT_PRESENTATION: Record<
  Port,
  { spoken: string; tone: string; label: 'handle' | 'edge' | null; dashed: boolean }
> = {
  out: { spoken: 'Next', tone: 'text-muted-foreground', label: null, dashed: false },
  error: { spoken: 'On error', tone: 'text-destructive', label: 'handle', dashed: true },
  true: { spoken: 'If true', tone: 'text-success', label: 'edge', dashed: false },
  false: { spoken: 'If false', tone: 'text-muted-foreground', label: 'edge', dashed: false },
  // Muted, not primary: blue is reserved for live work.
  item: { spoken: 'For each item', tone: 'text-muted-foreground', label: 'edge', dashed: false }
}

export const HANDLE_SIZE = 10
const PORT_PITCH = 18
const LAST_PORT_CENTRE = 49

/** Vertical centre of output `index` of `count`; the last port sits lowest. */
export function outputPortY(index: number, count: number): number {
  return LAST_PORT_CENTRE - PORT_PITCH * (count - 1 - index)
}

export const INPUT_PORT_Y = outputPortY(0, 2)
