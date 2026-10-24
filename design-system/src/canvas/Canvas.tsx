import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { Maximize2, Menu, Minus, Plus, RotateCcw } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/kbd'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import type { CanvasLayout } from '../registry/layout'
import type { PlacedEntry, SectionId } from '../registry/types'
import { CanvasItem } from './CanvasItem'
import {
  type Bounds,
  type Camera,
  cameraTransform,
  clamp,
  clampCamera,
  DEFAULT_CAMERA,
  fitBounds,
  type Point,
  zoomAt
} from './camera'
import { viewportKeyCommand } from './keyboard'
import { routeWheel, type WheelGesture } from './wheel-routing'

const TOOLBAR_HEIGHT = 56
const ZOOM_STEP = 1.2
const PAN_THRESHOLD = 3
const LINE_HEIGHT_PX = 16

interface CanvasProps {
  layout: CanvasLayout
  sections: { id: SectionId; title: string }[]
  positions: Record<string, Point>
  initialCamera: Camera | null
  themeControl: ReactNode
  onMove: (id: string, position: Point) => void
  /** Called synchronously on every camera change. Keep it cheap: no renders. */
  onCameraChange: (camera: Camera) => void
  /** Called once the camera has been still for a moment. */
  onCameraSettled: (camera: Camera) => void
  onResetLayout: () => void
}

function isEditable(element: Element | null): boolean {
  if (!element || element === document.body) return false
  if (element instanceof HTMLElement && element.isContentEditable) return true
  return Boolean(
    element.closest(
      'input, textarea, select, button, a[href], [role="button"], [role="menuitem"], [role="option"], [role="combobox"], [role="slider"], [role="switch"], [role="tab"], [role="checkbox"], [role="radio"]'
    )
  )
}

/** True when this element is a scroll container that can still move by the wheel delta. */
function canScrollBy(node: HTMLElement, dx: number, dy: number) {
  const style = getComputedStyle(node)
  const canY = /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight
  const canX = /(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth
  if (canY && dy !== 0) {
    if (dy < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1)
      return true
  }
  if (canX && dx !== 0) {
    if (dx < 0 ? node.scrollLeft > 0 : node.scrollLeft + node.clientWidth < node.scrollWidth - 1)
      return true
  }
  return false
}

/** Nearest scroll container inside a canvas item, from target upward, that can take this delta. */
function findScrollContainer(target: EventTarget | null, dx: number, dy: number) {
  const start = target instanceof Element ? target : null
  const item = start?.closest('[data-canvas-item]')
  let node = start
  while (node && item && node !== item) {
    if (node instanceof HTMLElement && canScrollBy(node, dx, dy)) return node
    node = node.parentElement
  }
  return null
}

/** Swallow the click that follows a pan so it does not activate a preview. */
function suppressNextClick() {
  const swallow = (event: Event) => {
    event.stopPropagation()
    event.preventDefault()
  }
  window.addEventListener('click', swallow, { capture: true, once: true })
  window.addEventListener('auxclick', swallow, { capture: true, once: true })
  window.setTimeout(() => {
    window.removeEventListener('click', swallow, { capture: true })
    window.removeEventListener('auxclick', swallow, { capture: true })
  }, 0)
}

export function Canvas({
  layout,
  sections,
  positions,
  initialCamera,
  themeControl,
  onMove,
  onCameraChange,
  onCameraSettled,
  onResetLayout
}: CanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const zoomLabelRef = useRef<HTMLSpanElement>(null)
  const cameraRef = useRef<Camera>(initialCamera ?? DEFAULT_CAMERA)
  const frameRef = useRef<number | null>(null)
  const settleTimer = useRef<number | undefined>(undefined)
  const spaceHeld = useRef(false)
  const panRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    origin: Camera
    moved: boolean
  } | null>(null)
  const touchesRef = useRef(new Map<number, Point>())
  const pinchRef = useRef<{ distance: number; mid: Point; origin: Camera } | null>(null)
  const wheelGestureRef = useRef<WheelGesture<HTMLElement> | null>(null)
  const onCameraChangeRef = useRef(onCameraChange)
  onCameraChangeRef.current = onCameraChange
  const onCameraSettledRef = useRef(onCameraSettled)
  onCameraSettledRef.current = onCameraSettled

  const write = useCallback(() => {
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      const camera = cameraRef.current
      if (worldRef.current) worldRef.current.style.transform = cameraTransform(camera)
      if (zoomLabelRef.current) zoomLabelRef.current.textContent = `${Math.round(camera.z * 100)}%`
    })
  }, [])

  const settle = useCallback(() => {
    window.clearTimeout(settleTimer.current)
    settleTimer.current = window.setTimeout(() => {
      onCameraSettledRef.current(cameraRef.current)
    }, 250)
  }, [])

  const setCamera = useCallback(
    (camera: Camera) => {
      cameraRef.current = clampCamera(camera)
      onCameraChangeRef.current(cameraRef.current)
      write()
      settle()
    },
    [settle, write]
  )

  const getZoom = useCallback(() => cameraRef.current.z, [])

  const viewportSize = useCallback(() => {
    const node = viewportRef.current
    return {
      width: node?.clientWidth ?? window.innerWidth,
      height: node?.clientHeight ?? window.innerHeight,
      top: TOOLBAR_HEIGHT
    }
  }, [])

  const measureBounds = useCallback(
    (filter?: (entry: PlacedEntry) => boolean): Bounds | null => {
      const world = worldRef.current
      if (!world) return null
      let bounds: Bounds | null = null
      const extend = (x: number, y: number, w: number, h: number) => {
        bounds = bounds
          ? {
              minX: Math.min(bounds.minX, x),
              minY: Math.min(bounds.minY, y),
              maxX: Math.max(bounds.maxX, x + w),
              maxY: Math.max(bounds.maxY, y + h)
            }
          : { minX: x, minY: y, maxX: x + w, maxY: y + h }
      }
      for (const node of world.querySelectorAll<HTMLElement>('[data-canvas-item]')) {
        const id = node.dataset.canvasItem ?? ''
        const entry = layout.entries.find((candidate) => candidate.id === id)
        if (!entry || (filter && !filter(entry))) continue
        // offset* values are untransformed canvas units.
        extend(node.offsetLeft, node.offsetTop, node.offsetWidth, node.offsetHeight)
      }
      if (!filter) {
        for (const node of world.querySelectorAll<HTMLElement>('[data-canvas-label]')) {
          extend(node.offsetLeft, node.offsetTop, node.offsetWidth, node.offsetHeight)
        }
      }
      return bounds
    },
    [layout.entries]
  )

  const fitAll = useCallback(() => {
    const bounds = measureBounds()
    if (bounds) setCamera(fitBounds(bounds, viewportSize()))
  }, [measureBounds, setCamera, viewportSize])

  const revealSection = useCallback(
    (section: SectionId) => {
      const bounds = measureBounds((entry) => entry.section === section)
      if (!bounds) return
      const label = layout.labels.find((candidate) => candidate.id === `section.${section}`)
      const withLabel: Bounds = label
        ? { ...bounds, minY: Math.min(bounds.minY, label.y), minX: Math.min(bounds.minX, label.x) }
        : bounds
      const size = viewportSize()
      // Show the section from its top-left at a readable zoom rather than squeezing it all in.
      const fitted = fitBounds(withLabel, size)
      const widthFit = (size.width - 96) / (withLabel.maxX - withLabel.minX)
      const z = Math.min(1, Math.max(fitted.z, 0.6, widthFit))
      setCamera({ x: 48 - withLabel.minX * z, y: size.top + 32 - withLabel.minY * z, z })
    },
    [layout.labels, measureBounds, setCamera, viewportSize]
  )

  const zoomBy = useCallback(
    (factor: number) => {
      const size = viewportSize()
      setCamera(zoomAt(cameraRef.current, size.width / 2, (size.height + size.top) / 2, factor))
    },
    [setCamera, viewportSize]
  )

  const resetCamera = useCallback(() => setCamera(DEFAULT_CAMERA), [setCamera])

  // First paint: apply the saved camera, or fit everything once fonts settle.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once on mount by design.
  useLayoutEffect(() => {
    write()
    if (initialCamera) return
    let cancelled = false
    void document.fonts.ready.then(() => {
      if (!cancelled) requestAnimationFrame(() => !cancelled && fitAll())
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Page-level gesture guards while the canvas is mounted.
  useEffect(() => {
    const html = document.documentElement
    const body = document.body
    const previous = {
      html: html.style.overscrollBehaviorX,
      body: body.style.overscrollBehaviorX
    }
    html.style.overscrollBehaviorX = 'none'
    body.style.overscrollBehaviorX = 'none'
    return () => {
      html.style.overscrollBehaviorX = previous.html
      body.style.overscrollBehaviorX = previous.body
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        // StrictMode remounts reuse this ref: a stale id would block every later write().
        frameRef.current = null
      }
      window.clearTimeout(settleTimer.current)
      wheelGestureRef.current = null
    }
  }, [])

  // Wheel: Ctrl/Meta (and trackpad pinch, which arrives as ctrl+wheel) zooms at the pointer.
  // Plain wheel picks one owner per gesture: a preview scroll area that can take it, or the camera.
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const onWheel = (event: WheelEvent) => {
      const scale = event.deltaMode === 1 ? LINE_HEIGHT_PX : event.deltaMode === 2 ? 400 : 1
      const dx = event.deltaX * scale
      const dy = event.deltaY * scale
      const { action, gesture } = routeWheel(wheelGestureRef.current, {
        time: event.timeStamp,
        dx,
        dy,
        zoom: event.ctrlKey || event.metaKey,
        findContainer: (x, y) => findScrollContainer(event.target, x, y),
        canScroll: canScrollBy,
        containsTarget: (container) =>
          event.target instanceof Node && container.contains(event.target)
      })
      wheelGestureRef.current = gesture
      if (action === 'native') return
      event.preventDefault()
      if (action === 'block') return
      if (action === 'scroll') {
        // The pointer left the latched preview; keep scrolling it, not the one under the pointer.
        if (gesture && gesture.owner !== 'canvas') gesture.owner.container.scrollBy(dx, dy)
        return
      }
      if (action === 'zoom') {
        const rect = viewport.getBoundingClientRect()
        const factor = Math.exp(-clamp(dy, -60, 60) * 0.01)
        setCamera(
          zoomAt(cameraRef.current, event.clientX - rect.left, event.clientY - rect.top, factor)
        )
        return
      }
      const horizontal = event.shiftKey && dx === 0 ? dy : dx
      const vertical = event.shiftKey && dx === 0 ? 0 : dy
      const camera = cameraRef.current
      setCamera({ ...camera, x: camera.x - horizontal, y: camera.y - vertical })
    }
    // Safari pinch: block page zoom over the canvas.
    const onGesture = (event: Event) => event.preventDefault()
    viewport.addEventListener('wheel', onWheel, { passive: false })
    viewport.addEventListener('gesturestart', onGesture)
    viewport.addEventListener('gesturechange', onGesture)
    return () => {
      viewport.removeEventListener('wheel', onWheel)
      viewport.removeEventListener('gesturestart', onGesture)
      viewport.removeEventListener('gesturechange', onGesture)
    }
  }, [setCamera])

  const endPan = useCallback(() => {
    const pan = panRef.current
    panRef.current = null
    viewportRef.current?.removeAttribute('data-panning')
    if (pan?.moved) suppressNextClick()
  }, [])

  // Space arms panning unless an editable or interactive control has focus.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat) return
      if (isEditable(document.activeElement)) return
      spaceHeld.current = true
      viewportRef.current?.setAttribute('data-space', '')
      event.preventDefault()
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return
      spaceHeld.current = false
      viewportRef.current?.removeAttribute('data-space')
    }
    const cancel = () => {
      spaceHeld.current = false
      viewportRef.current?.removeAttribute('data-space')
      touchesRef.current.clear()
      pinchRef.current = null
      endPan()
    }
    const onVisibility = () => document.hidden && cancel()
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', cancel)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', cancel)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [endPan])

  const startPan = (event: React.PointerEvent<HTMLElement>) => {
    event.preventDefault()
    viewportRef.current?.setPointerCapture(event.pointerId)
    viewportRef.current?.setAttribute('data-panning', '')
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: cameraRef.current,
      moved: false
    }
  }

  // Capture phase: middle button and Space+drag pan from anywhere, before previews see it.
  const onPointerDownCapture = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') return
    if (event.button === 1 || (event.button === 0 && spaceHeld.current)) {
      event.stopPropagation()
      startPan(event)
    }
  }

  // Empty canvas space: mouse drag pans; one finger pans, two fingers pinch.
  const onBackgroundPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') {
      touchesRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      event.currentTarget.setPointerCapture(event.pointerId)
      if (touchesRef.current.size === 2) {
        panRef.current = null
        const [a, b] = [...touchesRef.current.values()]
        pinchRef.current = {
          distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          origin: cameraRef.current
        }
        return
      }
      if (touchesRef.current.size === 1) startPan(event)
      return
    }
    if (event.button === 0) startPan(event)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (touchesRef.current.has(event.pointerId)) {
      touchesRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      const pinch = pinchRef.current
      if (pinch && touchesRef.current.size >= 2) {
        const [a, b] = [...touchesRef.current.values()]
        const rect = viewportRef.current?.getBoundingClientRect()
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        const factor = Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance
        const zoomed = zoomAt(
          pinch.origin,
          pinch.mid.x - (rect?.left ?? 0),
          pinch.mid.y - (rect?.top ?? 0),
          factor
        )
        setCamera({
          ...zoomed,
          x: zoomed.x + mid.x - pinch.mid.x,
          y: zoomed.y + mid.y - pinch.mid.y
        })
        return
      }
    }
    const pan = panRef.current
    if (!pan || pan.pointerId !== event.pointerId) return
    const dx = event.clientX - pan.startX
    const dy = event.clientY - pan.startY
    if (!pan.moved && Math.hypot(dx, dy) < PAN_THRESHOLD) return
    pan.moved = true
    setCamera({ ...pan.origin, x: pan.origin.x + dx, y: pan.origin.y + dy })
  }

  const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (touchesRef.current.delete(event.pointerId) && touchesRef.current.size < 2) {
      pinchRef.current = null
    }
    if (panRef.current?.pointerId === event.pointerId) endPan()
  }

  // Keyboard camera when the canvas itself has focus.
  const onViewportKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    const command = viewportKeyCommand(event)
    if (!command) return
    event.preventDefault()
    if (command.type === 'pan') {
      const camera = cameraRef.current
      setCamera({ ...camera, x: camera.x + command.by.x, y: camera.y + command.by.y })
    } else if (command.type === 'zoom-in') zoomBy(ZOOM_STEP)
    else if (command.type === 'zoom-out') zoomBy(1 / ZOOM_STEP)
    else if (command.type === 'reset') resetCamera()
    else fitAll()
  }

  // Keep keyboard focus visible: bring a focused preview control into view.
  const onFocusCapture = (event: React.FocusEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current
    const target = event.target
    if (!viewport || target === viewport || !(target instanceof HTMLElement)) return
    if (!worldRef.current?.contains(target)) return
    const rect = target.getBoundingClientRect()
    const box = viewport.getBoundingClientRect()
    const margin = 48
    let dx = 0
    let dy = 0
    if (rect.left < box.left + margin) dx = box.left + margin - rect.left
    else if (rect.right > box.right - margin) dx = box.right - margin - rect.right
    if (rect.top < box.top + TOOLBAR_HEIGHT + margin)
      dy = box.top + TOOLBAR_HEIGHT + margin - rect.top
    else if (rect.bottom > box.bottom - margin) dy = box.bottom - margin - rect.bottom
    if (dx || dy) {
      const camera = cameraRef.current
      setCamera({ ...camera, x: camera.x + dx, y: camera.y + dy })
    }
  }

  return (
    <div className="fixed inset-0 overflow-hidden bg-sidebar-background text-foreground">
      <div
        ref={viewportRef}
        role="application"
        aria-roledescription="canvas"
        aria-label="Termul design system canvas. Arrow keys pan, plus and minus zoom, F fits all, 0 resets."
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the canvas itself takes keyboard camera input.
        tabIndex={0}
        className={cn(
          'absolute inset-0 cursor-default overflow-hidden outline-none',
          'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          '[&[data-panning]_*]:select-none'
        )}
        onPointerDownCapture={onPointerDownCapture}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={onViewportKeyDown}
        onFocusCapture={onFocusCapture}
        // A focused control can scroll an overflow-hidden box; the camera owns position.
        onScroll={(event) => {
          event.currentTarget.scrollTop = 0
          event.currentTarget.scrollLeft = 0
        }}
      >
        <div
          aria-hidden
          data-canvas-background
          className="absolute inset-0 cursor-default touch-none"
          onPointerDown={onBackgroundPointerDown}
        />
        <div
          ref={worldRef}
          className="absolute top-0 left-0 origin-top-left"
          style={{ transform: cameraTransform(cameraRef.current) }}
        >
          {layout.labels.map((label) => (
            <div
              key={label.id}
              data-canvas-label
              className="pointer-events-none absolute select-none"
              style={{ left: label.x, top: label.y, width: label.width }}
            >
              {label.kind === 'section' ? (
                <div className="flex flex-col gap-2">
                  <h2 className="text-5xl font-semibold tracking-tight text-foreground">
                    {label.title}
                  </h2>
                  <p className="max-w-2xl text-lg text-muted-foreground">{label.description}</p>
                </div>
              ) : (
                <h3 className="border-b border-border pb-2 text-base font-medium text-muted-foreground">
                  {label.title}
                </h3>
              )}
            </div>
          ))}
          {layout.entries.map((entry) => (
            <CanvasItem
              key={entry.id}
              entry={entry}
              position={positions[entry.id] ?? { x: entry.x, y: entry.y }}
              getZoom={getZoom}
              onMove={onMove}
            />
          ))}
        </div>
      </div>

      <header
        className="absolute inset-x-0 top-0 z-10 flex items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur"
        style={{ height: TOOLBAR_HEIGHT }}
      >
        {/* Below xl the section links do not fit; they move into this menu along
            with the controls that get hidden on narrow widths. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="-ml-2 size-11 shrink-0 cursor-default touch-manipulation hover:text-foreground xl:hidden"
              aria-label="Sections and layout"
            >
              <Menu size={18} aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            collisionPadding={8}
            // Short viewports (browser zoom, landscape phones): cap the panel to
            // the space Radix measures below the trigger and scroll inside it,
            // so every item stays reachable.
            className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-56 overflow-x-hidden overflow-y-auto overscroll-contain"
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>Sections</DropdownMenuLabel>
              {sections.map((section) => (
                <DropdownMenuItem
                  key={section.id}
                  className="min-h-11 cursor-default gap-2"
                  onSelect={() => revealSection(section.id)}
                >
                  {section.title}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator className="md:hidden" />
            <DropdownMenuGroup className="md:hidden">
              <DropdownMenuLabel>View</DropdownMenuLabel>
              <DropdownMenuItem
                className="min-h-11 cursor-default gap-2"
                onSelect={() => zoomBy(ZOOM_STEP)}
              >
                <Plus size={16} aria-hidden />
                Zoom in
              </DropdownMenuItem>
              <DropdownMenuItem
                className="min-h-11 cursor-default gap-2"
                onSelect={() => zoomBy(1 / ZOOM_STEP)}
              >
                <Minus size={16} aria-hidden />
                Zoom out
              </DropdownMenuItem>
              <DropdownMenuItem className="min-h-11 cursor-default gap-2" onSelect={onResetLayout}>
                <RotateCcw size={16} aria-hidden />
                Reset layout
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex min-w-0 shrink-0 items-baseline gap-2">
          <h1 className="whitespace-nowrap text-sm font-semibold">
            Termul<span className="hidden md:inline"> design system</span>
          </h1>
          <span className="hidden text-xs text-muted-foreground tabular-nums md:inline">
            v{import.meta.env.PACKAGE_VERSION}
          </span>
        </div>
        <nav aria-label="Sections" className="hidden items-center gap-0.5 xl:flex">
          {sections.map((section) => (
            <Button
              key={section.id}
              variant="ghost"
              size="sm"
              className="cursor-default hover:text-foreground"
              onClick={() => revealSection(section.id)}
            >
              {section.title}
            </Button>
          ))}
        </nav>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {themeControl}
          <Separator orientation="vertical" className="hidden h-5 md:block" />
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              className="hidden cursor-default hover:text-foreground md:inline-flex"
              aria-label="Zoom out"
              onClick={() => zoomBy(1 / ZOOM_STEP)}
            >
              <Minus size={16} aria-hidden />
            </Button>
            <span
              ref={zoomLabelRef}
              aria-live="off"
              className="hidden w-11 text-center text-xs text-muted-foreground tabular-nums md:inline"
            >
              {Math.round(cameraRef.current.z * 100)}%
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              className="hidden cursor-default hover:text-foreground md:inline-flex"
              aria-label="Zoom in"
              onClick={() => zoomBy(ZOOM_STEP)}
            >
              <Plus size={16} aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="cursor-default hover:text-foreground"
              aria-label="Fit all"
              title="Fit all (F)"
              onClick={fitAll}
            >
              <Maximize2 size={16} aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="cursor-default hover:text-foreground"
              aria-label="Reset camera"
              title="Reset camera (0)"
              onClick={resetCamera}
            >
              <RotateCcw size={16} aria-hidden />
            </Button>
          </div>
          <Separator orientation="vertical" className="hidden h-5 md:block" />
          <Button
            variant="ghost"
            size="sm"
            className="hidden cursor-default hover:text-foreground md:inline-flex"
            onClick={onResetLayout}
          >
            Reset layout
          </Button>
        </div>
      </header>

      <p
        id="canvas-move-hint"
        className="pointer-events-none absolute bottom-3 left-4 z-10 hidden items-center gap-1.5 rounded-md bg-background/90 px-2 py-1 text-xs text-muted-foreground backdrop-blur lg:flex"
      >
        Drag empty space or hold <Kbd>Space</Kbd> to pan. <Kbd>Ctrl</Kbd> + scroll to zoom. Drag or
        arrow-key a grip to move an item.
      </p>
    </div>
  )
}
