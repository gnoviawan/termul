import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { App } from './App'
import { LAYOUT_STORAGE_KEY } from './canvas/layout-storage'

// One plain preview keeps the canvas small; the real registry is not under test here.
vi.mock('./registry', () => ({
  SECTIONS: [
    {
      id: 'foundations',
      title: 'Foundations',
      description: 'Test section',
      groups: [
        {
          id: 'test',
          title: 'Test',
          entries: [
            {
              id: 'test.box',
              name: 'Box',
              source: 'test',
              width: 200,
              height: 100,
              Preview: () => <div>Box preview</div>
            }
          ]
        }
      ]
    }
  ]
}))

function savedLayout() {
  const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY)
  return raw ? JSON.parse(raw) : null
}

function renderApp() {
  render(
    <TooltipProvider>
      <App />
    </TooltipProvider>
  )
}

describe('design-system App layout saves', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    window.localStorage.clear()
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        v: 1,
        camera: { x: 0, y: 0, z: 1 },
        themeId: null,
        positions: { 'test.box': { x: 100, y: 100 } }
      })
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    window.localStorage.clear()
  })

  it('saves the latest camera on pagehide before the settle delay', () => {
    renderApp()
    const viewport = screen.getByRole('application')
    fireEvent.keyDown(viewport, { key: 'ArrowLeft' })
    // pagehide arrives before the 250 ms settle callback.
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(savedLayout()?.camera).toEqual({ x: 80, y: 0, z: 1 })
  })

  it('saves a moved item on pagehide right after the move', () => {
    renderApp()
    const grip = screen.getByRole('button', { name: 'Move Box' })
    fireEvent.keyDown(grip, { key: 'ArrowRight' })
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(savedLayout()?.positions?.['test.box']).toEqual({ x: 108, y: 100 })
  })
})
