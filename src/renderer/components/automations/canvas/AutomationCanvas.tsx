import type { Automation } from '@shared/types/automation.types'
import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import {
  NODE_KIND_PRESENTATION,
  nodeKeyDetail,
  nodeLabels,
  triggerSummary
} from '../automation-format'
import { AutomationFlow } from './flow/AutomationFlow'
import { drawableEdges } from './layout'
import { PORT_PRESENTATION, TRIGGER } from './ports'

interface AutomationCanvasProps {
  automation: Pick<Automation, 'graph' | 'trigger' | 'layout'>
  /** The phone shell: a readable first zoom, touch-sized controls, no minimap. */
  phone: boolean
}

/**
 * The automation as a read-only canvas, left to right. Screen readers get
 * the same steps and branches as a list instead of the drawing.
 */
export function AutomationCanvas({ automation, phone }: AutomationCanvasProps): React.JSX.Element {
  const { graph, trigger } = automation
  const spoken = useMemo(() => {
    const labels = nodeLabels(graph.nodes)
    const edges = drawableEdges(graph)
    const branches = (from: string): string[] =>
      edges
        .filter((edge) => edge.from === from)
        .map((edge) => `${PORT_PRESENTATION[edge.port].spoken}: ${labels.get(edge.to) ?? edge.to}`)
    return [
      { id: TRIGGER, lines: [`Trigger: ${triggerSummary(trigger)}`, ...branches(TRIGGER)] },
      ...graph.nodes.map((node) => ({
        id: node.id,
        lines: [
          `${node.label}, ${NODE_KIND_PRESENTATION[node.spec.kind].label}: ${nodeKeyDetail(node.spec)}`,
          ...branches(node.id)
        ]
      }))
    ]
  }, [graph, trigger])

  return (
    <div
      data-testid="automation-canvas"
      className={cn(
        'relative overflow-hidden rounded-lg border border-border',
        phone ? 'h-80' : 'h-[440px]'
      )}
    >
      <ol className="sr-only" aria-label="Automation steps">
        {spoken.map((step) => (
          <li key={step.id}>{step.lines.join('. ')}</li>
        ))}
      </ol>
      <AutomationFlow automation={automation} phone={phone} />
    </div>
  )
}
