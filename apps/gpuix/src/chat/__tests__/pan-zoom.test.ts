import { describe, expect, test } from 'bun:test'
import {
  canZoomIn,
  canZoomOut,
  fitted,
  INLINE_MAX_HEIGHT,
  initialView,
  panned,
  placement,
  reset,
  wheeled,
  ZOOM_STEP,
  zoomedBy
} from '../pan-zoom'

/** The matrix transcript's router flowchart as Chromium lays it out (`tools/chat/mermaid-card-probe.ts`). */
const ROUTER = { width: 1016.52, height: 278 }
const round = (n: number) => Math.round(n * 100) / 100

describe('the inline diagram frame', () => {
  test('fits the diagram to the frame width and takes its fitted height', () => {
    const view = fitted(initialView(), ROUTER, { width: 714, height: 0 }, 'inline')
    expect(round(view.zoom)).toBe(0.7)
    expect(round(view.stageHeight ?? 0)).toBe(195.27)
    const box = placement(view, ROUTER, { width: 714, height: view.stageHeight ?? 0 })
    expect([box.left, box.top, box.width, box.height].map(round)).toEqual([0, 0, 714, 195.27])
  })

  test('one Zoom in grows the diagram by a tenth about the frame centre, as Streamdown does', () => {
    const view = zoomedBy(
      fitted(initialView(), ROUTER, { width: 714, height: 0 }, 'inline'),
      ZOOM_STEP
    )
    const box = placement(view, ROUTER, { width: 714, height: 195.27 })
    expect([round(box.left), round(box.top), round(box.width), round(box.height)]).toEqual([
      -50.83, -13.9, 815.65, 223.07
    ])
  })

  test('a small diagram keeps its own size', () => {
    const view = fitted(
      initialView(),
      { width: 200, height: 80 },
      { width: 714, height: 0 },
      'inline'
    )
    expect(view.zoom).toBe(1)
    expect(view.stageHeight).toBe(80)
  })

  test('a tall diagram stops at the frame limit and scales to fit under it', () => {
    const view = fitted(
      initialView(),
      { width: 400, height: 1600 },
      { width: 714, height: 0 },
      'inline'
    )
    expect(view.stageHeight).toBe(INLINE_MAX_HEIGHT)
    expect(view.zoom).toBe(INLINE_MAX_HEIGHT / 1600)
  })
})

describe('fullscreen', () => {
  test('fits both ways but never enlarges, and centres the diagram', () => {
    const stage = { width: 1248, height: 768 }
    const view = fitted(initialView(), ROUTER, stage, 'fullscreen')
    expect(view.zoom).toBe(1)
    expect(view.stageHeight).toBeNull()
    const box = placement(view, ROUTER, stage)
    expect([round(box.left), round(box.top)]).toEqual([115.74, 245])
  })
})

describe('zoom and pan', () => {
  const start = () => fitted(initialView(), ROUTER, { width: 714, height: 0 }, 'inline')

  test('zoom stops at three times and at half size or the fit, whichever is smaller', () => {
    let view = start()
    for (let i = 0; i < 40; i++) view = zoomedBy(view, ZOOM_STEP)
    expect(view.zoom).toBe(3)
    expect(canZoomIn(view)).toBe(false)
    for (let i = 0; i < 40; i++) view = zoomedBy(view, -ZOOM_STEP)
    expect(view.zoom).toBe(0.5)
    expect(canZoomOut(view)).toBe(false)
    expect(canZoomIn(view)).toBe(true)
  })

  test('the wheel zooms out on a downward turn and in on an upward one', () => {
    expect(round(wheeled(start(), 3).zoom)).toBe(0.6)
    expect(round(wheeled(start(), -3).zoom)).toBe(0.8)
  })

  test('a drag moves the diagram by the pointer travel from where it began', () => {
    const view = panned(start(), { x: 30, y: -12 })
    expect(view.pan).toEqual({ x: 30, y: -12 })
    expect(placement(view, ROUTER, { width: 714, height: 195.27 }).left).toBe(30)
  })

  test('a resize refits an untouched view and leaves a zoomed one alone', () => {
    const wider = { width: 900, height: 0 }
    expect(round(fitted(start(), ROUTER, wider, 'inline').zoom)).toBe(0.89)
    const zoomed = zoomedBy(panned(start(), { x: 5, y: 5 }), ZOOM_STEP)
    const refit = fitted(zoomed, ROUTER, wider, 'inline')
    expect(round(refit.zoom)).toBe(0.8)
    expect(refit.pan).toEqual({ x: 5, y: 5 })
  })

  test('reset goes back to the fit, centred, and refits again on resize', () => {
    const back = reset(zoomedBy(panned(start(), { x: 40, y: 2 }), ZOOM_STEP))
    expect(round(back.zoom)).toBe(0.7)
    expect(back.pan).toEqual({ x: 0, y: 0 })
    expect(round(fitted(back, ROUTER, { width: 900, height: 0 }, 'inline').zoom)).toBe(0.89)
  })
})
