import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TitleBar } from './TitleBar'

const { mockWindowApi, platformState, maximizeRef } = vi.hoisted(() => ({
  mockWindowApi: {
    onMaximizeChange: vi.fn(),
    minimize: vi.fn(),
    toggleMaximize: vi.fn().mockResolvedValue({ success: true, data: false }),
    close: vi.fn()
  },
  platformState: { isMac: false },
  maximizeRef: { cb: null as null | ((maximized: boolean) => void) }
}))

vi.mock('@/lib/api', () => ({
  windowApi: mockWindowApi
}))

vi.mock('@/lib/platform', () => ({
  get isMac() {
    return platformState.isMac
  }
}))

describe('TitleBar (window control strip)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    platformState.isMac = false
    maximizeRef.cb = null
    mockWindowApi.onMaximizeChange.mockImplementation((cb: (maximized: boolean) => void) => {
      maximizeRef.cb = cb
      return vi.fn()
    })
  })

  it('renders window controls on Windows/Linux', () => {
    render(<TitleBar />)

    expect(screen.getByRole('button', { name: 'Minimize window' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Maximize window' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close window' })).toBeInTheDocument()
  })

  it('renders nothing on macOS (native traffic lights)', () => {
    platformState.isMac = true
    const { container } = render(<TitleBar />)

    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('button', { name: 'Minimize window' })).not.toBeInTheDocument()
  })

  it('minimizes the window on click', () => {
    render(<TitleBar />)

    fireEvent.click(screen.getByRole('button', { name: 'Minimize window' }))

    expect(mockWindowApi.minimize).toHaveBeenCalledTimes(1)
  })

  it('toggles maximize on click', async () => {
    render(<TitleBar />)

    fireEvent.click(screen.getByRole('button', { name: 'Maximize window' }))

    await waitFor(() => {
      expect(mockWindowApi.toggleMaximize).toHaveBeenCalledTimes(1)
    })
  })

  it('closes the window on click', () => {
    render(<TitleBar />)

    fireEvent.click(screen.getByRole('button', { name: 'Close window' }))

    expect(mockWindowApi.close).toHaveBeenCalledTimes(1)
  })

  it('reflects maximize state via onMaximizeChange', () => {
    render(<TitleBar />)

    act(() => {
      maximizeRef.cb?.(true)
    })

    expect(screen.getByRole('button', { name: 'Restore window' })).toBeInTheDocument()
  })
})
