/**
 * `react-resizable-panels` 2.x stand-in. The package measures DOM panels it
 * finds with `document.querySelector` and listens for pointer events on
 * `document`; neither exists here. Panels register with their group through
 * context, sizes are flex-grow percentages as in the package, and dragging a
 * handle resizes the two panels around it with the package's arithmetic
 * (`panel-layout.ts`).
 *
 * The visible handle stays the 1px line the shared class string draws. The
 * grab area is a 9px strip in a pointer-transparent overlay that mirrors the
 * panel row and paints last: a strip inside the handle would sit under the
 * next panel, which GPUIX paints (and hit-tests) after it.
 */

import {
  type CSSProperties,
  createContext,
  Fragment,
  forwardRef,
  type ReactNode,
  useCallback,
  useContext,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  defaultLayout,
  type PanelConstraints,
  resizeAtHandle,
  sameLayout,
  validateLayout
} from './panel-layout'

type Direction = 'horizontal' | 'vertical'

export type PanelOnResize = (size: number, prevSize: number | undefined) => void
export type PanelGroupOnLayout = (layout: number[]) => void

export interface ImperativePanelGroupHandle {
  getId(): string
  getLayout(): number[]
  setLayout(layout: number[]): void
}

export interface ImperativePanelHandle {
  getId(): string
  getSize(): number
  resize(size: number): void
  isCollapsed(): boolean
  isExpanded(): boolean
  collapse(): void
  expand(): void
}

type AnyProps = {
  children?: ReactNode
  className?: string
  style?: Record<string, unknown>
  [prop: string]: any
}

interface PanelEntry {
  id: string
  order: number | undefined
  /** Registration sequence: the tie-break for panels without `order`. */
  seq: number
  constraints: PanelConstraints
  onResize: PanelOnResize | undefined
}

interface HandleEntry {
  onDragging: ((dragging: boolean) => void) | undefined
  disabled: boolean
}

interface GroupContextValue {
  groupId: string
  direction: Direction
  sizeOf(panelId: string): number | undefined
  registerPanel(entry: PanelEntry): () => void
  updatePanel(entry: PanelEntry): void
  registerHandle(entry: HandleEntry): () => void
}

const GroupContext = createContext<GroupContextValue | null>(null)

/** The handle line's thickness in the shared class string (`w-px` / `h-px`). */
const HANDLE_PX = 1
const GRAB_PX = 9

const GRAB_COLUMN: CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  left: -(GRAB_PX - HANDLE_PX) / 2,
  width: GRAB_PX,
  cursor: 'col-resize',
  pointerEvents: 'auto'
}
const GRAB_ROW: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  top: -(GRAB_PX - HANDLE_PX) / 2,
  height: GRAB_PX,
  cursor: 'row-resize',
  pointerEvents: 'auto'
}
const SLOT_COLUMN: CSSProperties = { position: 'relative', flexShrink: 0, width: HANDLE_PX }
const SLOT_ROW: CSSProperties = { position: 'relative', flexShrink: 0, height: HANDLE_PX }

let panelSeq = 0

function byOrder(a: PanelEntry, b: PanelEntry): number {
  if (a.order !== undefined && b.order !== undefined && a.order !== b.order)
    return a.order - b.order
  return a.seq - b.seq
}

interface DragStart {
  pivot: number
  at: number
  size: number
  layout: number[]
}

export const PanelGroup = forwardRef<ImperativePanelGroupHandle, AnyProps>(function PanelGroup(
  {
    id,
    direction = 'horizontal',
    onLayout,
    className,
    style,
    children,
    tagName: Tag = 'div',
    autoSaveId: _autoSaveId,
    storage: _storage,
    keyboardResizeBy: _keyboardResizeBy,
    ...rest
  },
  ref
) {
  const fallbackId = useId()
  const groupId: string = id ?? fallbackId
  const panels = useRef(new Map<string, PanelEntry>())
  const handles = useRef<HandleEntry[]>([])
  const [order, setOrder] = useState<string[]>([])
  const [layout, setLayout] = useState<number[]>([])
  const layoutRef = useRef<number[]>([])
  const reported = useRef<Map<string, number>>(new Map())
  const reportedLayout = useRef<number[] | null>(null)
  const element = useRef<{ getBoundingClientRect(): { width: number; height: number } } | null>(
    null
  )
  const drag = useRef<DragStart | null>(null)
  const onLayoutRef = useRef<PanelGroupOnLayout | undefined>(onLayout)
  onLayoutRef.current = onLayout

  const ordered = useCallback(() => [...panels.current.values()].sort(byOrder), [])
  const constraintsOf = useCallback(() => ordered().map((p) => p.constraints), [ordered])

  // The package calls onLayout and each panel's onResize as it sets a layout, so
  // what a consumer stores from them renders with the sizes. Deferred to an
  // effect, a stored size could land a render after its layout and the
  // consumer's own setLayout could chase it forever (EditorTocLayout's outline).
  const report = useCallback(
    (next: readonly number[]) => {
      const entries = ordered()
      if (next.length === 0 || next.length !== entries.length) return
      if (!reportedLayout.current || !sameLayout(reportedLayout.current, next)) {
        reportedLayout.current = [...next]
        onLayoutRef.current?.([...next])
      }
      entries.forEach((panel, i) => {
        const prev = reported.current.get(panel.id)
        if (prev !== undefined && Math.abs(prev - next[i]) < 1e-6) return
        reported.current.set(panel.id, next[i])
        panel.onResize?.(next[i], prev)
      })
    },
    [ordered]
  )

  /** Registration commits without reporting: the group reports once every panel has registered. */
  const commit = useCallback(
    (next: number[], reportNow = true) => {
      if (sameLayout(layoutRef.current, next)) return
      layoutRef.current = next
      setLayout(next)
      if (reportNow) report(next)
    },
    [report]
  )

  // The panel set changed: lay the current panels out from their default sizes.
  const syncPanels = useCallback(() => {
    const entries = ordered()
    const ids = entries.map((p) => p.id)
    setOrder((prev) =>
      prev.length === ids.length && prev.every((p, i) => p === ids[i]) ? prev : ids
    )
    commit(defaultLayout(entries.map((p) => p.constraints)), false)
  }, [ordered, commit])

  const registerPanel = useCallback(
    (entry: PanelEntry) => {
      panels.current.set(entry.id, entry)
      syncPanels()
      return () => {
        if (panels.current.get(entry.id) !== entry) return
        panels.current.delete(entry.id)
        reported.current.delete(entry.id)
        syncPanels()
      }
    },
    [syncPanels]
  )
  const updatePanel = useCallback(
    (entry: PanelEntry) => {
      if (!panels.current.has(entry.id)) return
      panels.current.set(entry.id, entry)
      if (layoutRef.current.length === panels.current.size) {
        commit(validateLayout(layoutRef.current, constraintsOf()))
      }
    },
    [commit, constraintsOf]
  )
  const registerHandle = useCallback((entry: HandleEntry) => {
    handles.current.push(entry)
    return () => {
      handles.current = handles.current.filter((h) => h !== entry)
    }
  }, [])
  const context = useMemo<GroupContextValue>(
    () => ({
      groupId,
      direction,
      sizeOf: (panelId) => {
        const index = order.indexOf(panelId)
        return index === -1 ? undefined : layout[index]
      },
      registerPanel,
      updatePanel,
      registerHandle
    }),
    [groupId, direction, order, layout, registerPanel, updatePanel, registerHandle]
  )

  useImperativeHandle(
    ref,
    () => ({
      getId: () => groupId,
      getLayout: () => [...layoutRef.current],
      setLayout: (next: number[]) => commit(validateLayout(next, constraintsOf()))
    }),
    [groupId, commit, constraintsOf]
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new panel set reports even when its default layout equals the last one
  useLayoutEffect(() => report(layout), [layout, order, report])

  const horizontal = direction === 'horizontal'
  const handleFor = (pivot: number): HandleEntry | undefined =>
    handles.current[pivot] ?? handles.current[0]

  const onGrab = (pivot: number, event: { button: number; clientX: number; clientY: number }) => {
    if (event.button !== 0 || handleFor(pivot)?.disabled) return
    const box = element.current?.getBoundingClientRect()
    const size = (horizontal ? box?.width : box?.height) ?? 0
    if (size <= 0) return
    drag.current = {
      pivot,
      at: horizontal ? event.clientX : event.clientY,
      size,
      layout: [...layoutRef.current]
    }
    handleFor(pivot)?.onDragging?.(true)
  }
  const onMove = (event: { clientX: number; clientY: number }) => {
    const start = drag.current
    if (!start) return
    const delta = (((horizontal ? event.clientX : event.clientY) - start.at) / start.size) * 100
    commit(resizeAtHandle(start.layout, delta, start.pivot, constraintsOf()))
  }
  const onRelease = () => {
    const start = drag.current
    if (!start) return
    drag.current = null
    handleFor(start.pivot)?.onDragging?.(false)
  }

  const grabStyle = horizontal ? GRAB_COLUMN : GRAB_ROW

  return (
    <GroupContext.Provider value={context}>
      <Tag
        ref={element}
        className={className}
        data-panel-group=""
        data-panel-group-direction={direction}
        data-panel-group-id={groupId}
        style={{
          display: 'flex',
          flexDirection: horizontal ? 'row' : 'column',
          height: '100%',
          width: '100%',
          overflow: 'hidden',
          position: 'relative',
          ...style
        }}
        {...rest}
      >
        {children}
        {order.length > 1 && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              left: 0,
              display: 'flex',
              flexDirection: horizontal ? 'row' : 'column',
              pointerEvents: 'none'
            }}
          >
            {order.map((panelId, i) => (
              <Fragment key={panelId}>
                <div style={{ flexBasis: 0, flexGrow: layout[i] ?? 0, flexShrink: 1 }} />
                {i < order.length - 1 && (
                  <div style={horizontal ? SLOT_COLUMN : SLOT_ROW}>
                    <div
                      data-testid={`resize-handle-${groupId}-${i}`}
                      style={grabStyle}
                      onPointerDown={(e: { button: number; clientX: number; clientY: number }) =>
                        onGrab(i, e)
                      }
                      onPointerMove={onMove}
                      onPointerUp={onRelease}
                    />
                  </div>
                )}
              </Fragment>
            ))}
          </div>
        )}
      </Tag>
    </GroupContext.Provider>
  )
})

function useGroup(component: string): GroupContextValue {
  const group = useContext(GroupContext)
  if (!group)
    throw new Error(`${component} components must be rendered within a PanelGroup container`)
  return group
}

export const Panel = forwardRef<ImperativePanelHandle, AnyProps>(function Panel(
  {
    id,
    order,
    defaultSize,
    minSize,
    maxSize,
    onResize,
    className,
    style,
    children,
    tagName: Tag = 'div',
    collapsible: _collapsible,
    collapsedSize: _collapsedSize,
    onCollapse: _onCollapse,
    onExpand: _onExpand,
    ...rest
  },
  ref
) {
  const group = useGroup('Panel')
  const fallbackId = useId()
  const panelId: string = id ?? fallbackId
  const seq = useRef(-1)
  if (seq.current === -1) seq.current = panelSeq++
  const entry = useMemo<PanelEntry>(
    () => ({
      id: panelId,
      order,
      seq: seq.current,
      constraints: { defaultSize, minSize, maxSize },
      onResize
    }),
    [panelId, order, defaultSize, minSize, maxSize, onResize]
  )
  const latest = useRef(entry)
  latest.current = entry
  const { registerPanel, updatePanel } = group
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-register only when identity or order changes; the rest updates in place
  useLayoutEffect(() => registerPanel(latest.current), [registerPanel, panelId, order])
  useLayoutEffect(() => updatePanel(entry), [updatePanel, entry])

  const size = group.sizeOf(panelId)
  useImperativeHandle(
    ref,
    () => ({
      getId: () => panelId,
      getSize: () => group.sizeOf(panelId) ?? 0,
      resize: () => {},
      isCollapsed: () => false,
      isExpanded: () => true,
      collapse: () => {},
      expand: () => {}
    }),
    [panelId, group]
  )

  return (
    <Tag
      className={className}
      data-panel=""
      data-panel-id={panelId}
      data-panel-group-id={group.groupId}
      data-panel-size={size === undefined ? undefined : size.toFixed(1)}
      style={{
        flexBasis: 0,
        flexGrow: size ?? defaultSize ?? 1,
        flexShrink: 1,
        overflow: 'hidden',
        ...style
      }}
      {...rest}
    >
      {children}
    </Tag>
  )
})

export function PanelResizeHandle({
  className,
  style,
  children,
  disabled = false,
  onDragging,
  tagName: Tag = 'div',
  hitAreaMargins: _hitAreaMargins,
  ...rest
}: AnyProps) {
  const group = useGroup('PanelResizeHandle')
  const entry = useRef<HandleEntry>({ onDragging, disabled })
  entry.current.onDragging = onDragging
  entry.current.disabled = disabled
  const { registerHandle } = group
  useLayoutEffect(() => registerHandle(entry.current), [registerHandle])
  return (
    <Tag
      role="separator"
      className={className}
      data-panel-group-direction={group.direction}
      data-panel-group-id={group.groupId}
      data-resize-handle=""
      data-resize-handle-state="inactive"
      data-panel-resize-handle-enabled={!disabled}
      style={{ touchAction: 'none', userSelect: 'none', flexShrink: 0, ...style }}
      {...rest}
    >
      {children}
    </Tag>
  )
}

export function getPanelGroupElement(): null {
  return null
}
