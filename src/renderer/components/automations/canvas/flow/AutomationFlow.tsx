import type { Automation } from '@shared/types/automation.types'
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  getViewportForBounds,
  MiniMap,
  type OnNodesChange,
  ReactFlow,
  ReactFlowProvider,
  type Rect,
  useReactFlow,
  useStore,
  useStoreApi,
  type Viewport
} from '@xyflow/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Maximize2, ZoomIn, ZoomOut } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { TRIGGER } from '../ports'
import { CardNodeView } from './CardNodeView'
import { type CardNode, contentBounds, type PortEdge, reuseUnchanged, toFlow } from './flow-graph'
import { PortEdgeView } from './PortEdgeView'
import './flow.css'

const nodeTypes = { card: CardNodeView }
const edgeTypes = { port: PortEdgeView }

/** Below this a card's 14 px title is too small to read, so the first view pans instead of fitting. */
const READABLE_ZOOM = { desktop: 0.75, phone: 0.85 }
const MARGIN = 24

/**
 * The first view: the whole graph when it fits at a readable zoom, else the
 * readable zoom with the graph's left edge in view, centred on the trigger
 * when the graph is also too tall.
 */
function startViewport(bounds: Rect, trigger: Rect, view: Viewport & Rect, min: number): Viewport {
  const fit = Math.min(
    1,
    (view.width - 2 * MARGIN) / bounds.width,
    (view.height - 2 * MARGIN) / bounds.height
  )
  if (fit >= min) {
    return {
      zoom: fit,
      x: (view.width - bounds.width * fit) / 2 - bounds.x * fit,
      y: (view.height - bounds.height * fit) / 2 - bounds.y * fit
    }
  }
  const focusY =
    bounds.height * min <= view.height - 2 * MARGIN
      ? bounds.y + bounds.height / 2
      : trigger.y + trigger.height / 2
  return { zoom: min, x: MARGIN - bounds.x * min, y: view.height / 2 - focusY * min }
}

function ReadableStart({ phone }: { phone: boolean }): null {
  const flow = useReactFlow<CardNode, PortEdge>()
  const width = useStore((s) => s.width)
  const height = useStore((s) => s.height)
  const done = useRef(false)
  useEffect(() => {
    if (done.current || width === 0 || height === 0) return
    const nodes = flow.getNodes()
    const trigger = nodes.find((node) => node.id === TRIGGER)
    if (!trigger) return
    done.current = true
    void flow.setViewport(
      startViewport(
        contentBounds(nodes),
        flow.getNodesBounds([trigger]),
        { x: 0, y: 0, zoom: 1, width, height },
        phone ? READABLE_ZOOM.phone : READABLE_ZOOM.desktop
      )
    )
  }, [flow, width, height, phone])
  return null
}

function ViewControls({ phone }: { phone: boolean }): React.JSX.Element {
  const flow = useReactFlow<CardNode, PortEdge>()
  const store = useStoreApi()
  const size = phone ? 'touch' : 'icon-sm'
  const square = phone ? 'w-11' : undefined
  const controls = [
    {
      label: 'Fit to view',
      Icon: Maximize2,
      run: () => {
        // fitView would use the bare node boxes and clip slots and `error` labels.
        const { width, height, minZoom } = store.getState()
        const view = getViewportForBounds(
          contentBounds(flow.getNodes()),
          width,
          height,
          minZoom,
          1,
          0.1
        )
        return flow.setViewport(view, { duration: 200 })
      }
    },
    { label: 'Zoom in', Icon: ZoomIn, run: () => flow.zoomIn({ duration: 150 }) },
    { label: 'Zoom out', Icon: ZoomOut, run: () => flow.zoomOut({ duration: 150 }) }
  ]
  return (
    <div
      role="toolbar"
      aria-label="Diagram view"
      className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border border-border bg-popover p-1 shadow-lg"
    >
      {controls.map(({ label, Icon, run }) => (
        <Button
          key={label}
          variant="ghost"
          size={size}
          className={square}
          aria-label={label}
          title={label}
          onClick={() => void run()}
        >
          <Icon size={16} />
        </Button>
      ))}
    </div>
  )
}

/**
 * React Flow in view mode: pan, zoom and select, no dragging or connecting.
 * Host updates merge through `reuseUnchanged`, so an unchanged card keeps its
 * object, skips a re-render and stays selected.
 */
export function AutomationFlow({
  automation,
  phone
}: {
  automation: Pick<Automation, 'graph' | 'trigger' | 'layout'>
  phone: boolean
}): React.JSX.Element {
  const { graph, trigger, layout } = automation
  const next = useMemo(() => toFlow({ graph, trigger, layout }), [graph, trigger, layout])
  const [nodes, setNodes] = useState<CardNode[]>(next.nodes)
  const [edges, setEdges] = useState<PortEdge[]>(next.edges)
  useEffect(() => {
    setNodes((prev) => reuseUnchanged(prev, next.nodes))
    setEdges((prev) => reuseUnchanged(prev, next.edges))
  }, [next])
  // View mode: only selection and measurement may change a card, never its existence or position.
  const onNodesChange: OnNodesChange<CardNode> = (changes) =>
    setNodes((prev) =>
      applyNodeChanges(
        changes.filter((change) => change.type === 'select' || change.type === 'dimensions'),
        prev
      )
    )

  return (
    <ReactFlowProvider>
      {/* Phone: one finger scrolls the page (`touch-action: pan-y` in flow.css),
          so React Flow only sees a touch once a second finger lands, and two
          fingers pinch and pan like an embedded map. */}
      <div
        className="size-full"
        onTouchStartCapture={
          phone
            ? (event) => {
                if (event.touches.length < 2) event.stopPropagation()
              }
            : undefined
        }
      >
        <ReactFlow<CardNode, PortEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          nodesDraggable={false}
          deleteKeyCode={null}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          // The detail page scrolls; the wheel scrolls it. Pinch and the buttons zoom.
          zoomOnScroll={false}
          preventScrolling={false}
          minZoom={0.2}
          maxZoom={2}
          attributionPosition="bottom-left"
          className={cn('automation-flow bg-background', phone && 'automation-flow-touch')}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1.5}
            color="oklch(var(--foreground) / 0.16)"
          />
          {!phone && (
            <MiniMap
              pannable
              ariaLabel="Diagram overview"
              className="m-3 overflow-hidden rounded-lg border border-border shadow-lg"
              style={{ width: 144, height: 88 }}
            />
          )}
          <ReadableStart phone={phone} />
        </ReactFlow>
      </div>
      <ViewControls phone={phone} />
    </ReactFlowProvider>
  )
}
