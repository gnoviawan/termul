import { BaseEdge, EdgeLabelRenderer, type EdgeProps, getBezierPath } from '@xyflow/react'
import { cn } from '@/lib/utils'
import { PORT_PRESENTATION } from '../ports'
import type { PortEdge } from './flow-graph'

/** An edge in its port's colour, dashed for `error`, named mid-edge when the port says so. */
export function PortEdgeView({
  id,
  data,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition
}: EdgeProps<PortEdge>): React.JSX.Element {
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
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className={cn('stroke-current', look.tone, look.dashed && '[stroke-dasharray:5_4]')}
      />
      {look.label === 'edge' && (
        <EdgeLabelRenderer>
          <span
            aria-hidden="true"
            data-testid={`edge-label-${id}`}
            className={cn(
              'pointer-events-none absolute rounded-sm bg-background px-1 text-xs leading-4',
              look.tone
            )}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {port}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
