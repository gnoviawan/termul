import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TrafficLightClearance,
  WINDOW_CONTROLS_INSET_PX,
  WindowControls,
  WindowControlsInset
} from './TopRowChrome'

const { mockWindowApi, maximizeRef } = vi.hoisted(() => ({
  mockWindowApi: {
    onMaximizeChange: vi.fn(),
    minimize: vi.fn(),
    toggleMaximize: vi.fn().mockResolvedValue({ success: true, data: false }),
    close: vi.fn()
  },
  maximizeRef: { cb: null as null | ((maximized: boolean) => void) }
}))

vi.mock('@/lib/api', () => ({ windowApi: mockWindowApi }))

beforeEach(() => {
  vi.clearAllMocks()
  maximizeRef.cb = null
  mockWindowApi.onMaximizeChange.mockImplementation((cb: (maximized: boolean) => void) => {
    maximizeRef.cb = cb
    return vi.fn()
  })
})

describe('WindowControls', () => {
  it('renders nothing unless windowControls is set, and does not subscribe', () => {
    const { container } = render(<WindowControls windowControls={false} />)
    expect(container).toBeEmptyDOMElement()
    expect(mockWindowApi.onMaximizeChange).not.toHaveBeenCalled()
  })

  it('renders the three controls with the TitleBar names and no drag attribute', () => {
    render(<WindowControls windowControls />)
    const wrapper = screen.getByTestId('window-controls')
    expect(wrapper).not.toHaveAttribute('data-tauri-drag-region')
    for (const name of ['Minimize window', 'Maximize window', 'Close window']) {
      const button = screen.getByRole('button', { name })
      expect(button).toHaveClass('h-full', 'w-10')
      expect(button).not.toHaveAttribute('data-tauri-drag-region')
    }
    expect(screen.getByRole('button', { name: 'Close window' })).toHaveClass(
      'hover:bg-destructive-fill',
      'hover:text-destructive-foreground'
    )
    // Three 40px buttons: a fixed 120px block the top row can leave room for.
    expect(wrapper).toHaveStyle({ width: '120px' })
  })

  it('takes a className for its placement', () => {
    render(<WindowControls windowControls className="absolute top-0 right-0" />)
    expect(screen.getByTestId('window-controls')).toHaveClass('absolute', 'top-0', 'right-0')
  })

  it('calls the window api', () => {
    render(<WindowControls windowControls />)
    fireEvent.click(screen.getByRole('button', { name: 'Minimize window' }))
    fireEvent.click(screen.getByRole('button', { name: 'Maximize window' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close window' }))
    expect(mockWindowApi.minimize).toHaveBeenCalledTimes(1)
    expect(mockWindowApi.toggleMaximize).toHaveBeenCalledTimes(1)
    expect(mockWindowApi.close).toHaveBeenCalledTimes(1)
  })

  it('swaps to Restore while maximized', () => {
    render(<WindowControls windowControls />)
    act(() => maximizeRef.cb?.(true))
    expect(screen.getByRole('button', { name: 'Restore window' })).toHaveAttribute(
      'title',
      'Restore'
    )
    act(() => maximizeRef.cb?.(false))
    expect(screen.getByRole('button', { name: 'Maximize window' })).toBeInTheDocument()
  })
})

describe('TrafficLightClearance', () => {
  it('renders nothing unless trafficLights is set', () => {
    const { container } = render(<TrafficLightClearance trafficLights={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('is a 76px drag spacer', () => {
    render(<TrafficLightClearance trafficLights />)
    const spacer = screen.getByTestId('traffic-light-clearance')
    expect(spacer).toHaveStyle({ width: '76px' })
    expect(spacer).toHaveAttribute('data-tauri-drag-region')
  })
})

describe('WindowControlsInset', () => {
  it('renders nothing unless windowControls is set', () => {
    const { container } = render(<WindowControlsInset windowControls={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('is a drag spacer as wide as the controls part left of the 44px strip', () => {
    render(<WindowControlsInset windowControls />)
    const spacer = screen.getByTestId('window-controls-inset')
    expect(WINDOW_CONTROLS_INSET_PX).toBe(76)
    expect(spacer).toHaveStyle({ width: '76px' })
    expect(spacer).toHaveAttribute('data-tauri-drag-region')
  })
})
