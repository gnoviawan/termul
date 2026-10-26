/**
 * The pan and zoom of a mermaid diagram, as Streamdown's `PanZoom` keeps it:
 * the diagram starts fitted to its frame, the buttons and the wheel step the
 * zoom by a tenth between half size (or the fit, if smaller) and three times,
 * a drag moves it, and reset returns to the fit. A view nobody has zoomed or
 * dragged refits when the frame resizes. GPUIX has no transforms, so the
 * card places the diagram's image from `placement` instead of scaling it.
 */

export interface Size {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** Inline, the frame is as tall as the fitted diagram; fullscreen, the diagram fits the frame. */
export type PanZoomMode = 'inline' | 'fullscreen'

export interface PanZoomView {
  /** The zoom that fits the diagram to the frame; 1 until the frame has a size. */
  fit: number
  zoom: number
  /** The least zoom: half size, or the fit when that is smaller. */
  minZoom: number
  pan: Point
  /** Zoomed or dragged since the last fit or reset, so a resize keeps the view. */
  touched: boolean
  /** Inline, the frame's height; `null` fullscreen and before the first fit. */
  stageHeight: number | null
}

export const ZOOM_STEP = 0.1
export const MAX_ZOOM = 3
const MIN_ZOOM = 0.5
/** The inline frame's `max-h-[min(70vh,40rem)]` in the 800 px window. */
export const INLINE_MAX_HEIGHT = 560

export function initialView(): PanZoomView {
  return { fit: 1, zoom: 1, minZoom: MIN_ZOOM, pan: { x: 0, y: 0 }, touched: false, stageHeight: null }
}

function fitOf(content: Size, stage: Size, mode: PanZoomMode): { fit: number; stageHeight: number | null } | null {
  if (!(stage.width > 0 && content.width > 0 && content.height > 0)) return null
  if (mode === 'fullscreen') {
    if (!(stage.height > 0)) return null
    return { fit: Math.min(stage.width / content.width, stage.height / content.height, 1), stageHeight: null }
  }
  const byWidth = Math.min(stage.width / content.width, 1)
  const stageHeight = Math.min(content.height * byWidth, INLINE_MAX_HEIGHT)
  return { fit: Math.min(byWidth, stageHeight / content.height, 1), stageHeight }
}

/** The view after the frame took `stage` (inline reads only its width). */
export function fitted(view: PanZoomView, content: Size, stage: Size, mode: PanZoomMode): PanZoomView {
  const next = fitOf(content, stage, mode)
  if (!next) return view
  const minZoom = Math.min(MIN_ZOOM, next.fit)
  if (view.touched) return { ...view, ...next, minZoom }
  return { ...view, ...next, minZoom, zoom: next.fit, pan: { x: 0, y: 0 } }
}

export function zoomedBy(view: PanZoomView, delta: number): PanZoomView {
  return { ...view, zoom: Math.max(view.minZoom, Math.min(MAX_ZOOM, view.zoom + delta)), touched: true }
}

/** One wheel event, its `deltaY` in DOM terms (positive turns the wheel toward the user). */
export function wheeled(view: PanZoomView, deltaY: number): PanZoomView {
  return zoomedBy(view, deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP)
}

export function panned(view: PanZoomView, pan: Point): PanZoomView {
  return { ...view, pan, touched: true }
}

export function reset(view: PanZoomView): PanZoomView {
  return { ...view, zoom: view.fit, pan: { x: 0, y: 0 }, touched: false }
}

export function canZoomIn(view: PanZoomView): boolean {
  return view.zoom < MAX_ZOOM
}

export function canZoomOut(view: PanZoomView): boolean {
  return view.zoom > view.minZoom
}

/** Where the diagram's image sits in a `stage`-sized frame: scaled about the frame's centre, then moved by the pan. */
export function placement(view: PanZoomView, content: Size, stage: Size): Size & { left: number; top: number } {
  const width = content.width * view.zoom
  const height = content.height * view.zoom
  return {
    left: (stage.width - width) / 2 + view.pan.x,
    top: (stage.height - height) / 2 + view.pan.y,
    width,
    height
  }
}
