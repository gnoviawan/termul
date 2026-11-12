import type {
  Automation,
  Edge,
  Issue,
  NodeId,
  NodeKind,
  NodePosition,
  Port
} from '@shared/types/automation.types'
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Connection,
  getViewportForBounds,
  MiniMap,
  type OnEdgesChange,
  type OnNodesChange,
  ReactFlow,
  ReactFlowProvider,
  type Rect,
  useReactFlow,
  useStore,
  useStoreApi,
  type Viewport
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { refuseConnect } from '../draft/apply-op'
import { NODE_KIND_MIME } from '../palette/AddNodeMenu'
import { CARD, INPUT_PORT_Y, SLOT_DEPTH, TRIGGER } from '../ports'
import { CardNodeView } from './CardNodeView'
import { ConnectBanner } from './ConnectBanner'
import { FlowToolbar, type Tool } from './FlowToolbar'
import { type ConnectFrom, EdgeHoverContext, type FlowEdit, FlowEditContext } from './flow-edit'
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

/** Centres and selects the card an issue points at. */
function FocusCard({ focus }: { focus: { id: string; nonce: number } | null }): null {
  const flow = useReactFlow<CardNode, PortEdge>()
  // A step just added reaches React Flow a render later: wait for its card.
  const present = useStore((s) => (focus ? s.nodeLookup.has(focus.id) : false))
  const done = useRef<number | null>(null)
  useEffect(() => {
    if (!focus || !present || done.current === focus.nonce) return
    const node = flow.getNode(focus.id)
    if (!node) return
    done.current = focus.nonce
    flow.setNodes((nodes) => nodes.map((n) => ({ ...n, selected: n.id === focus.id })))
    void flow.setCenter(
      node.position.x + (node.width ?? 0) / 2,
      node.position.y + (node.height ?? 0) / 2,
      { zoom: Math.max(flow.getZoom(), 0.9), duration: 200 }
    )
  }, [flow, focus, present])
  return null
}

function edgeOf(connection: Connection): Edge {
  return {
    from: connection.source as NodeId,
    port: connection.sourceHandle as Edge['port'],
    to: connection.target as NodeId
  }
}

/** Gap between a step and the one chained after it. */
const CHAIN_GAP = 80

function clientPoint(event: MouseEvent | TouchEvent | React.MouseEvent): { x: number; y: number } {
  if ('changedTouches' in event && event.changedTouches.length > 0) {
    const touch = event.changedTouches[0]
    return { x: touch.clientX, y: touch.clientY }
  }
  const mouse = event as MouseEvent
  return { x: mouse.clientX, y: mouse.clientY }
}

/** `at`, moved down past any card it would cover (slots included), so a new step lands in the clear. */
function freeSpot(at: NodePosition, cards: readonly CardNode[]): NodePosition {
  const covers = (y: number) =>
    cards.some(
      (card) =>
        Math.abs(card.position.x - at.x) < CARD.width + 16 &&
        Math.abs(card.position.y - y) < CARD.height + SLOT_DEPTH
    )
  let y = at.y
  while (covers(y)) y += CARD.height + SLOT_DEPTH
  return { x: at.x, y }
}

function isTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  )
}

interface FlowProps {
  automation: Pick<Automation, 'graph' | 'trigger' | 'layout'>
  phone: boolean
  issues?: readonly Issue[]
  /** Present in edit mode; absent, the canvas is view-only. */
  edit?: FlowEdit
  focus?: { id: string; nonce: number } | null
}

function Flow({ automation, phone, issues, edit, focus = null }: FlowProps): React.JSX.Element {
  const { graph, trigger, layout } = automation
  const editing = edit !== undefined
  const live = editing && !edit.locked
  const next = useMemo(
    () => toFlow({ graph, trigger, layout }, { issues, editing }),
    [graph, trigger, layout, issues, editing]
  )
  const [nodes, setNodes] = useState<CardNode[]>(next.nodes)
  const [edges, setEdges] = useState<PortEdge[]>(next.edges)
  useEffect(() => {
    setNodes((prev) => reuseUnchanged(prev, next.nodes))
    setEdges((prev) => reuseUnchanged(prev, next.edges))
  }, [next])
  const [tool, setTool] = useState<Tool>('select')
  const [connecting, setConnecting] = useState<ConnectFrom | null>(null)
  const connectingRef = useRef<ConnectFrom | null>(null)
  const startConnecting = (from: ConnectFrom | null): void => {
    connectingRef.current = from
    setConnecting(from)
  }
  const store = useStoreApi<CardNode, PortEdge>()
  const flow = useReactFlow<CardNode, PortEdge>()
  // The editor hands a new `edit` every render; cards read it through this ref so they stay memoized.
  const editRef = useRef(edit)
  editRef.current = edit
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null)
  const unhover = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverEdge = useCallback((id: string | null): void => {
    if (unhover.current) clearTimeout(unhover.current)
    // The "+" sits in an HTML layer over the edge: leaving the path for it must not hide it.
    if (id === null) unhover.current = setTimeout(() => setHoveredEdge(null), 200)
    else setHoveredEdge(id)
  }, [])

  /** A new step dropped at `point` (viewport), its input port under the pointer. */
  const pointToCard = (point: { x: number; y: number }): NodePosition => {
    const at = flow.screenToFlowPosition(point)
    return { x: Math.round(at.x), y: Math.round(at.y - INPUT_PORT_Y) }
  }
  const addFrom = useCallback(
    (from: Edge['from'], port: Port, screen: { x: number; y: number }): void => {
      const source = flow.getNode(from)
      if (!editRef.current || !source) return
      editRef.current.requestAdd({
        at: freeSpot(
          { x: source.position.x + CARD.width + CHAIN_GAP, y: source.position.y },
          flow.getNodes()
        ),
        from: { from, port },
        screen
      })
    },
    [flow]
  )
  const addAtCentre = (screen: { x: number; y: number }): void => {
    const box = store.getState().domNode?.getBoundingClientRect()
    if (!edit || !box) return
    const centre = flow.screenToFlowPosition({
      x: box.x + box.width / 2,
      y: box.y + box.height / 2
    })
    edit.requestAdd({
      at: freeSpot(
        { x: Math.round(centre.x - CARD.width / 2), y: Math.round(centre.y - CARD.height / 2) },
        flow.getNodes()
      ),
      screen
    })
  }

  const onNodesChange: OnNodesChange<CardNode> = (changes) => {
    // View mode: only selection and measurement may change a card, never its existence or
    // position. Edit mode also moves cards; the draft owns removal (`onBeforeDelete`).
    setNodes((prev) =>
      applyNodeChanges(
        changes.filter((change) =>
          editing
            ? change.type !== 'remove'
            : change.type === 'select' || change.type === 'dimensions'
        ),
        prev
      )
    )
    const moved: Record<string, { x: number; y: number }> = {}
    for (const change of changes) {
      if (change.type === 'position' && change.dragging === false && change.position) {
        moved[change.id] = change.position
      }
    }
    if (edit && Object.keys(moved).length > 0) edit.move(moved)
  }
  const onEdgesChange: OnEdgesChange<PortEdge> = (changes) =>
    setEdges((prev) =>
      applyEdgeChanges(
        changes.filter((change) => change.type === 'select'),
        prev
      )
    )

  const cancelConnecting = (): void => {
    store.setState({ connectionClickStartHandle: null })
    startConnecting(null)
  }
  /** Finishes a tap-to-connect on `to`, or says why it cannot. */
  const finishConnecting = (to: string): void => {
    const from = connectingRef.current
    if (!edit || !from) return
    cancelConnecting()
    if (to === from.from) return
    const edge: Edge = { from: from.from, port: from.port, to: to as NodeId }
    const refusal = refuseConnect(graph, edge)
    if (refusal) edit.refused(refusal)
    else edit.connect(edge)
  }

  const removeSelected = (): void => {
    if (!edit || edit.locked) return
    const nodeIds = nodes
      .filter((node) => node.selected && node.id !== TRIGGER)
      .map((node) => node.id as NodeId)
    const removed = edges
      .filter((edge) => edge.selected)
      .map(
        (edge) => ({ from: edge.source, port: edge.data?.port ?? 'out', to: edge.target }) as Edge
      )
    if (nodeIds.length > 0 || removed.length > 0) edit.remove(nodeIds, removed)
  }
  const hasSelection =
    nodes.some((node) => node.selected && node.id !== TRIGGER) ||
    edges.some((edge) => edge.selected)

  // Cards read the graph only while an edge is being drawn; otherwise a host update must not
  // hand every card a new context.
  const connectGraph = connecting ? graph : null
  const context = useMemo(
    () => ({
      // Cards offer no ports while Save runs.
      editing: live,
      connecting,
      canTake: (to: string) =>
        connecting !== null &&
        connectGraph !== null &&
        refuseConnect(connectGraph, {
          from: connecting.from,
          port: connecting.port,
          to: to as NodeId
        }) === null,
      addFrom,
      insertOn: (edge: Edge, at: NodePosition, screen: { x: number; y: number }) =>
        editRef.current?.requestAdd({ at, split: edge, screen })
    }),
    [live, connecting, connectGraph, addFrom]
  )
  const edgeHover = useMemo(() => ({ hoveredEdge, hoverEdge }), [hoveredEdge, hoverEdge])
  const labelOf = (id: string): string =>
    id === TRIGGER ? 'Trigger' : (graph.nodes.find((node) => node.id === id)?.label ?? id)

  return (
    <FlowEditContext.Provider value={context}>
      <EdgeHoverContext.Provider value={edgeHover}>
        {/* Phone view mode: one finger scrolls the page (`touch-action: pan-y` in
          flow.css), so React Flow only sees a touch once a second finger lands,
          and two fingers pinch and pan like an embedded map. The phone editor
          is full screen, so there one finger pans the canvas. */}
        <div
          role="group"
          aria-label="Automation canvas"
          className="size-full"
          onTouchStartCapture={
            phone && !editing
              ? (event) => {
                  if (event.touches.length < 2) event.stopPropagation()
                }
              : undefined
          }
          onDragOver={
            live
              ? (event) => {
                  if (!event.dataTransfer.types.includes(NODE_KIND_MIME)) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'copy'
                }
              : undefined
          }
          onDrop={
            editing
              ? (event) => {
                  const kind = event.dataTransfer.getData(NODE_KIND_MIME) as NodeKind
                  if (!kind || !edit || edit.locked) return
                  event.preventDefault()
                  const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
                  edit.drop(kind, {
                    x: Math.round(at.x - CARD.width / 2),
                    y: Math.round(at.y - CARD.height / 2)
                  })
                }
              : undefined
          }
          onKeyDown={
            editing
              ? (event) => {
                  if (isTextField(event.target)) return
                  if (event.key === 'Escape' && connectingRef.current) {
                    event.preventDefault()
                    cancelConnecting()
                  } else if (event.key === 'Delete' || event.key === 'Backspace') {
                    event.preventDefault()
                    removeSelected()
                  }
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
            onEdgesChange={onEdgesChange}
            nodesDraggable={live}
            nodesConnectable={live}
            nodesFocusable={editing}
            edgesFocusable={editing}
            deleteKeyCode={null}
            onBeforeDelete={async () => false}
            isValidConnection={(connection) =>
              refuseConnect(graph, edgeOf(connection as Connection)) === null
            }
            onConnect={(connection) => {
              startConnecting(null)
              edit?.connect(edgeOf(connection))
            }}
            onConnectStart={(_, { nodeId, handleId, handleType }) => {
              if (handleType === 'source' && nodeId && handleId) {
                startConnecting({
                  from: nodeId as Edge['from'],
                  port: handleId as Edge['port'],
                  tap: false
                })
              }
            }}
            onConnectEnd={(event, state) => {
              startConnecting(null)
              if (!edit || state.isValid || !state.fromNode || !state.fromHandle?.id) return
              if (!state.toNode) {
                const point = clientPoint(event)
                const from = {
                  from: state.fromNode.id as Edge['from'],
                  port: state.fromHandle.id as Port
                }
                // React Flow only snaps to a port; a drop on a card's body still means that card.
                const onCard = document
                  .elementFromPoint(point.x, point.y)
                  ?.closest('.react-flow__node')
                  ?.getAttribute('data-id')
                if (onCard) {
                  if (onCard === from.from) return
                  const edge: Edge = { ...from, to: onCard as NodeId }
                  const refusal = refuseConnect(graph, edge)
                  if (refusal) edit.refused(refusal)
                  else edit.connect(edge)
                  return
                }
                // Dropped on blank canvas: pick a new step to put there, already connected.
                edit.requestAdd({ at: pointToCard(point), from, screen: point })
              } else if (state.toNode.id !== state.fromNode.id) {
                const refusal = refuseConnect(graph, {
                  from: state.fromNode.id as Edge['from'],
                  port: state.fromHandle.id as Edge['port'],
                  to: state.toNode.id as NodeId
                })
                if (refusal) edit.refused(refusal)
              }
            }}
            connectOnClick={live}
            onClickConnectStart={(_, { nodeId, handleId, handleType }) => {
              if (handleType === 'source' && nodeId && handleId) {
                startConnecting({
                  from: nodeId as Edge['from'],
                  port: handleId as Edge['port'],
                  tap: true
                })
              } else {
                cancelConnecting()
              }
            }}
            onClickConnectEnd={(event) => {
              const target = (event.target as Element | null)?.closest?.('.react-flow__node')
              const to = target?.getAttribute('data-id')
              // A tap on blank canvas ends here first; `onPaneClick` takes it from there.
              if (!to) return
              if (connectingRef.current && to !== connectingRef.current.from) {
                const refusal = refuseConnect(graph, {
                  from: connectingRef.current.from,
                  port: connectingRef.current.port,
                  to: to as NodeId
                })
                // A legal tap already connected through `onConnect`.
                if (refusal) edit?.refused(refusal)
              }
              startConnecting(null)
            }}
            onNodeClick={(event, node) => {
              // A tap on a handle bubbles here after React Flow handled it.
              if ((event.target as Element).closest('.react-flow__handle')) return
              if (connectingRef.current) finishConnecting(node.id)
            }}
            onPaneClick={(event) => {
              const from = connectingRef.current
              if (!from) return
              cancelConnecting()
              // A tap on blank canvas while connecting offers a new step there, like a drop.
              const point = clientPoint(event)
              edit?.requestAdd({
                at: pointToCard(point),
                from: { from: from.from, port: from.port },
                screen: point
              })
            }}
            onEdgeMouseEnter={editing ? (_, edge) => hoverEdge(edge.id) : undefined}
            onEdgeMouseLeave={editing ? () => hoverEdge(null) : undefined}
            selectionOnDrag={editing && !phone && tool === 'select'}
            panOnDrag={editing && !phone && tool === 'select' ? [1, 2] : true}
            panOnScroll={editing && !phone}
            // The detail page scrolls; the wheel scrolls it. Pinch and the buttons zoom.
            zoomOnScroll={false}
            preventScrolling={editing}
            minZoom={0.2}
            maxZoom={2}
            attributionPosition="bottom-left"
            className={cn(
              'automation-flow bg-background',
              phone && !editing && 'automation-flow-touch'
            )}
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
            <FocusCard focus={focus} />
          </ReactFlow>
        </div>
        {connecting && (
          <ConnectBanner
            from={labelOf(connecting.from)}
            port={connecting.port}
            tap={connecting.tap}
            phone={phone}
            onCancel={cancelConnecting}
          />
        )}
        <FlowToolbar
          phone={phone}
          edit={edit}
          tool={tool}
          onTool={setTool}
          canDelete={live && hasSelection}
          onDelete={removeSelected}
          onFit={() => {
            // Not `fitView`: it fits bare node boxes, clipping slots and `error` labels, and it
            // waits for React Flow to count pre-sized cards as measured, which never happens here.
            const { width, height, minZoom } = store.getState()
            const view = getViewportForBounds(
              contentBounds(flow.getNodes()),
              width,
              height,
              minZoom,
              1,
              0.1
            )
            void flow.setViewport(view, { duration: 200 })
          }}
          onAdd={addAtCentre}
        />
      </EdgeHoverContext.Provider>
    </FlowEditContext.Provider>
  )
}

/**
 * React Flow behind one adapter. View mode: pan, zoom and select. Edit mode
 * (`edit`): drag cards, connect ports with the host's rules (drag, or tap a
 * port then a card), delete with the keyboard or the toolbar. Host updates
 * merge through `reuseUnchanged`, so an unchanged card keeps its object,
 * skips a re-render and stays selected.
 */
export function AutomationFlow(props: FlowProps): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  )
}
