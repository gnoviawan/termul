import type { Edge, NodeId } from '@shared/types/automation.types'
import { BaseEdge, EdgeLabelRenderer, type EdgeProps, getBezierPath } from '@xyflow/react'
import { Plus } from '@/components/icons'
import { cn } from '@/lib/utils'
import { CARD, INPUT_PORT_Y, PORT_PRESENTATION } from '../ports'
import { useFlowEdit } from './flow-edit'
import type { PortEdge } from './flow-graph'

/**
 * An edge in its port's colour, dashed for `error`, named mid-edge when the
 * port says so. While editing, a hovered or selected edge offers "+" at its
 * middle to insert a step there.
 */
export function PortEdgeView({
  id,
  source,
  target,
  data,
  selected,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition
}: EdgeProps<PortEdge>): React.JSX.Element {
  const { editing, hoveredEdge, hoverEdge, insertOn } = useFlowEdit()
  const port = data?.port ?? 'out'
  const look = PORT_PRESENTATION[port]
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition
  })
  const offerInsert = editing && (selected || hoveredEdge === id)
  const placed = { transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className={cn(
          'stroke-current',
          look.tone,
          look.dashed && '[stroke-dasharray:5_4]',
          selected && '[stroke-width:2.5]'
        )}
      />
      {look.label === 'edge' && !offerInsert && (
        <EdgeLabelRenderer>
          <span
            aria-hidden="true"
            data-testid={`edge-label-${id}`}
            className={cn(
              'pointer-events-none absolute rounded-sm bg-background px-1 text-xs leading-4',
              look.tone
            )}
            style={placed}
          >
            {port}
          </span>
        </EdgeLabelRenderer>
      )}
      {offerInsert && (
        <EdgeLabelRenderer>
          <button
            type="button"
            aria-label="Insert a step here"
            title="Insert a step here"
            className="nodrag nopan pointer-events-auto absolute grid size-5 place-items-center rounded-full border border-field-border bg-card text-muted-foreground shadow-xs hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:outline-none pointer-coarse:size-8"
            style={placed}
            onPointerEnter={() => hoverEdge(id)}
            onPointerLeave={() => hoverEdge(null)}
            onClick={(event) => {
              event.stopPropagation()
              const box = event.currentTarget.getBoundingClientRect()
              const edge: Edge = { from: source as Edge['from'], port, to: target as NodeId }
              insertOn(
                edge,
                { x: Math.round(labelX - CARD.width / 2), y: Math.round(labelY - INPUT_PORT_Y) },
                { x: box.right, y: box.top }
              )
            }}
          >
            <Plus size={12} />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
