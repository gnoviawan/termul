import type { AutomationNode, NodeId, NodeSpec, Port } from '@shared/types/automation.types'
import { describe, expect, it } from 'vitest'
import { CARD, SLOT_DEPTH } from '../ports'
import { panToShow } from './flow-graph'

const step = (spec: NodeSpec, x: number, y: number, open: Port[] = []) => ({
  position: { x, y },
  data: {
    kind: 'step' as const,
    node: { id: 'a' as NodeId, label: 'A', spec } satisfies AutomationNode,
    issues: 0,
    open
  }
})
const agent: NodeSpec = {
  kind: 'agent',
  agent_id: 'claude-code',
  model: null,
  prompt: '',
  output_schema: { type: 'string' },
  timeout_ms: 1000,
  max_attempts: 1,
  tools: []
}
const wait: NodeSpec = { kind: 'wait', duration_ms: 1000 }
const view = { x: 0, y: 0, zoom: 1 }
const size = { width: 800, height: 400, rightInset: 356 }

describe('panToShow', () => {
  it('leaves a card that is fully in the free area where it is', () => {
    expect(panToShow(step(wait, 10, 10), view, size)).toBeNull()
  })

  it('centres a card the floating inspector covers in the area left of it', () => {
    expect(panToShow(step(wait, 400, 10), view, size)).toEqual({
      zoom: 1,
      x: (800 - 356) / 2 - (400 + CARD.width / 2),
      y: 200 - (10 + CARD.height / 2)
    })
  })

  it("counts an agent card's config slots, which hang below the card", () => {
    // The card fits; its slots would end below the canvas.
    const y = 400 - CARD.height - 10
    expect(panToShow(step(wait, 10, y), view, size)).toBeNull()
    expect(panToShow(step(agent, 10, y), view, size)).toEqual({
      zoom: 1,
      x: (800 - 356) / 2 - (10 + CARD.width / 2),
      y: 200 - (y + (CARD.height + SLOT_DEPTH) / 2)
    })
  })

  it('pans a new step whose "+" would sit under the inspector clear of it', () => {
    // The card ends 10 px left of the inspector; its "+" would reach under it.
    const x = 800 - 356 - CARD.width - 10
    expect(panToShow(step(wait, x, 10), view, size)).toBeNull()
    expect(panToShow(step(wait, x, 10, ['out']), view, size)).toEqual({
      zoom: 1,
      x: (800 - 356) / 2 - (x + CARD.width / 2),
      y: 200 - (10 + CARD.height / 2)
    })
  })
})
