import { act, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasLayout } from '../registry/layout'
import { Canvas } from './Canvas'

const EMPTY_LAYOUT: CanvasLayout = {
  entries: [],
  labels: [],
  sectionBounds: {} as CanvasLayout['sectionBounds']
}

let queue = new Map<number, FrameRequestCallback>()
let nextId = 1

function flushFrames() {
  act(() => {
    const pending = queue
    queue = new Map()
    for (const callback of pending.values()) callback(performance.now())
  })
}

beforeEach(() => {
  queue = new Map()
  nextId = 1
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = nextId++
    queue.set(id, callback)
    return id
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    queue.delete(id)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Canvas under StrictMode', () => {
  it('still moves the camera after the dev double mount', () => {
    const onCameraChange = vi.fn()
    render(
      <StrictMode>
        <Canvas
          layout={EMPTY_LAYOUT}
          sections={[]}
          positions={{}}
          initialCamera={{ x: 0, y: 0, z: 1 }}
          themeControl={null}
          onMove={() => {}}
          onCameraChange={onCameraChange}
          onCameraSettled={() => {}}
          onResetLayout={() => {}}
        />
      </StrictMode>
    )
    flushFrames()
    onCameraChange.mockClear()

    const viewport = screen.getByRole('application')
    act(() => {
      viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    // The camera write must schedule a paint frame; a stale frame id from the
    // StrictMode cleanup used to swallow it, so the transform never updated.
    expect(onCameraChange).toHaveBeenCalled()
    expect(queue.size).toBe(1)
    flushFrames()
    expect(queue.size).toBe(0)
  })

  it('zoom in changes the world transform after the dev double mount', () => {
    const { container } = render(
      <StrictMode>
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
      </StrictMode>
    )
    flushFrames()
    const world = container.querySelector<HTMLElement>('[role="application"] .origin-top-left')
    expect(world).not.toBeNull()
    const before = world?.style.transform
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    flushFrames()
    expect(world?.style.transform).not.toBe(before)
  })
})
