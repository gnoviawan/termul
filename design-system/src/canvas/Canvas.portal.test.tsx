import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { CanvasLayout } from '../registry/layout'
import { Canvas } from './Canvas'

beforeEach(() => {
  // Camera writes run on the next frame; run them at once.
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callback(performance.now())
    return 1
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderCanvas(onCameraChange: () => void = () => {}): void {
  render(
    <Canvas
      layout={LAYOUT}
      sections={[]}
      positions={{}}
      initialCamera={{ x: 0, y: 0, z: 0.82 }}
      themeControl={null}
      onMove={() => {}}
      onCameraChange={onCameraChange}
      onCameraSettled={() => {}}
      onResetLayout={() => {}}
    />
  )
}

function PreviewWithFlyout(): React.JSX.Element {
  return (
    <Popover open>
      <PopoverTrigger>Edit</PopoverTrigger>
      <PopoverContent>Flyout body</PopoverContent>
    </Popover>
  )
}

const LAYOUT: CanvasLayout = {
  entries: [
    {
      id: 'demo.flyout',
      name: 'Flyout',
      source: 'demo.tsx',
      width: 300,
      height: 200,
      Preview: PreviewWithFlyout,
      section: 'components',
      group: 'demo',
      x: 0,
      y: 0
    }
  ],
  labels: [],
  sectionBounds: {} as CanvasLayout['sectionBounds']
}

describe('Canvas portal layer', () => {
  it('portals a preview popover into the zoomed world, not document.body', () => {
    renderCanvas()
    const flyout = screen.getByText('Flyout body')
    const layer = flyout.closest('[data-canvas-portal-layer]')
    expect(layer).not.toBeNull()
    // The layer shares the preview's scaled ancestor, so both zoom together.
    const item = document.querySelector('[data-canvas-item="demo.flyout"]')
    expect(layer?.parentElement).toBe(item?.parentElement)
    expect((layer?.parentElement as HTMLElement).style.transform).toContain('scale(0.82)')
    expect(layer?.className).not.toMatch(/overflow-(hidden|clip)/)
    // Floating UI reads the zoom from the layer's size; a 0×0 layer reads as 1.
    expect(layer?.className).toContain('size-px')
    expect(layer?.className).toContain('[contain:layout]')
  })
  it('focus inside a popover does not move the camera (focus in a preview does)', () => {
    const onCameraChange = vi.fn()
    renderCanvas(onCameraChange)
    const flyout = screen.getByText('Flyout body').closest<HTMLElement>('[role="dialog"]')
    act(() => flyout?.focus())
    expect(document.activeElement).toBe(flyout)
    expect(onCameraChange).not.toHaveBeenCalled()

    // Control: the same jsdom geometry pans the camera for a preview control.
    act(() => screen.getByText('Edit').focus())
    expect(onCameraChange).toHaveBeenCalled()
  })
})
