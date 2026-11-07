import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { CanvasLayout } from '../registry/layout'
import { Canvas } from './Canvas'

const EMPTY_LAYOUT: CanvasLayout = {
  entries: [],
  labels: [],
  sectionBounds: {} as CanvasLayout['sectionBounds']
}

function renderCanvas() {
  render(
    <Canvas
      layout={EMPTY_LAYOUT}
      sections={[]}
      positions={{}}
      initialCamera={{ x: 0, y: 0, z: 1 }}
      themeControl={null}
      onMove={() => {}}
      onCameraChange={() => {}}
      onCameraSettled={() => {}}
      onResetLayout={() => {}}
    />
  )
  return screen.getByRole('application')
}

function press(target: HTMLElement, init: KeyboardEventInit) {
  const event = createEvent.keyDown(target, init)
  fireEvent(target, event)
  return event.defaultPrevented
}

describe('Canvas keyboard', () => {
  it('handles plain camera keys', () => {
    const viewport = renderCanvas()
    expect(press(viewport, { key: 'ArrowLeft' })).toBe(true)
    expect(press(viewport, { key: '=' })).toBe(true)
    expect(press(viewport, { key: '0' })).toBe(true)
    expect(press(viewport, { key: 'f' })).toBe(true)
  })

  it.each([
    { key: 'f', ctrlKey: true },
    { key: 'f', metaKey: true },
    { key: '0', metaKey: true },
    { key: '=', ctrlKey: true },
    { key: '-', metaKey: true },
    { key: 'ArrowLeft', altKey: true }
  ])('leaves browser shortcut %o alone', (init) => {
    const viewport = renderCanvas()
    expect(press(viewport, init)).toBe(false)
  })
})
