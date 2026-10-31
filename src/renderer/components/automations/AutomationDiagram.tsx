import type { Graph, Port, Trigger } from '@shared/types/automation.types'
import { useId, useMemo } from 'react'
import { Clock, Zap } from '@/components/icons'
import { cn } from '@/lib/utils'
import { NODE_KIND_PRESENTATION, nodeKeyDetail, triggerSummary } from './automation-format'
import { type LayoutMetrics, layoutGraph, TRIGGER } from './automation-layout'

const WIDE: LayoutMetrics = { nodeWidth: 216, nodeHeight: 58, gapX: 24, gapY: 44 }
const NARROW: LayoutMetrics = { nodeWidth: 156, nodeHeight: 58, gapX: 12, gapY: 44 }

const PORTS: Port[] = ['out', 'error', 'true', 'false']

const EDGE_CLASS: Record<Port, string> = {
  out: 'text-muted-foreground',
  error: 'text-destructive',
  true: 'text-success',
  false: 'text-muted-foreground'
}

interface AutomationDiagramProps {
  graph: Graph
  trigger: Trigger
  narrow?: boolean
}

/**
 * Read-only diagram: node cards in the DOM over an SVG of the edges, top to
 * bottom so it fits a phone. Wider graphs scroll sideways.
 */
export function AutomationDiagram({
  graph,
  trigger,
  narrow = false
}: AutomationDiagramProps): React.JSX.Element {
  const metrics = narrow ? NARROW : WIDE
  const layout = useMemo(() => layoutGraph(graph, metrics), [graph, metrics])
  const nodes = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph])
  const markerPrefix = useId()

  return (
    <div className="overflow-x-auto pb-1" data-testid="automation-diagram">
      <div
        className="relative mx-auto"
        style={{ width: layout.width, height: layout.height }}
        role="img"
        aria-label={`Automation diagram with ${graph.nodes.length} steps`}
      >
        <svg
          className="pointer-events-none absolute inset-0 overflow-visible"
          width={layout.width}
          height={layout.height}
          aria-hidden="true"
        >
          <defs>
            {PORTS.map((port) => (
              // A marker paints in its own context, so each edge colour has one.
              <marker
                key={port}
                id={`${markerPrefix}-${port}`}
                className={EDGE_CLASS[port]}
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto"
              >
                <path d="M0,0 L8,4 L0,8 z" className="fill-current" />
              </marker>
            ))}
          </defs>
          {layout.edges.map((edge) => {
            const bend = Math.max(16, (edge.y2 - edge.y1) / 2)
            return (
              <path
                key={`${edge.from}-${edge.port}-${edge.to}`}
                className={cn('stroke-current', EDGE_CLASS[edge.port])}
                d={`M${edge.x1},${edge.y1} C${edge.x1},${edge.y1 + bend} ${edge.x2},${edge.y2 - bend} ${edge.x2},${edge.y2}`}
                fill="none"
                strokeWidth={1.25}
                strokeDasharray={edge.port === 'error' ? '4 3' : undefined}
                markerEnd={`url(#${markerPrefix}-${edge.port})`}
              />
            )
          })}
        </svg>

        {layout.edges
          .filter((edge) => edge.port !== 'out')
          .map((edge) => (
            <span
              key={`label-${edge.from}-${edge.port}-${edge.to}`}
              className={cn(
                'absolute -translate-x-1/2 -translate-y-1/2 rounded-sm bg-background px-1 text-3xs leading-4',
                EDGE_CLASS[edge.port]
              )}
              style={{ left: (edge.x1 + edge.x2) / 2, top: (edge.y1 + edge.y2) / 2 }}
            >
              {edge.port}
            </span>
          ))}

        {layout.nodes.map((placed) => {
          const style = {
            left: placed.x,
            top: placed.y,
            width: metrics.nodeWidth,
            height: metrics.nodeHeight
          }
          if (placed.id === TRIGGER) {
            const Icon = trigger.kind === 'manual' ? Zap : Clock
            return (
              <DiagramCard
                key={TRIGGER}
                style={style}
                icon={<Icon size={14} />}
                label="Trigger"
                detail={triggerSummary(trigger)}
                dashed
              />
            )
          }
          const node = nodes.get(placed.id)
          if (!node) return null
          const { Icon, label } = NODE_KIND_PRESENTATION[node.spec.kind]
          return (
            <DiagramCard
              key={node.id}
              style={style}
              icon={<Icon size={14} aria-label={label} />}
              label={node.label}
              detail={nodeKeyDetail(node.spec)}
            />
          )
        })}
      </div>
    </div>
  )
}

function DiagramCard({
  style,
  icon,
  label,
  detail,
  dashed = false
}: {
  style: React.CSSProperties
  icon: React.ReactNode
  label: string
  detail: string
  dashed?: boolean
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'absolute flex flex-col justify-center gap-0.5 rounded-lg border bg-card px-2.5 shadow-xs',
        dashed ? 'border-dashed border-field-border' : 'border-border'
      )}
      style={style}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div className="truncate font-mono text-2xs text-muted-foreground" title={detail}>
        {detail}
      </div>
    </div>
  )
}
