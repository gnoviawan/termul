import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResizeEdges } from './ResizeEdges'

// Issue #843: the z-9999 resize edge strips must only mount inside the Linux
// Tauri desktop window. `navigator.platform` reports Linux-like strings on
// Android ("Linux armv8l") and iOS ("iPhone"), so `isLinux` alone mounted the
// strips in mobile browsers where they swallowed edge taps. The component
// must self-gate on `isTauriContext()`.
const { tauriRef, isLinuxRef } = vi.hoisted(() => ({
  tauriRef: { current: true },
  isLinuxRef: { current: true }
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => tauriRef.current
}))

vi.mock('@/lib/platform', () => ({
  get isLinux() {
    return isLinuxRef.current
  }
}))

vi.mock('@/lib/tauri-window', () => ({
  getCurrentWindow: () => ({
    startResizeDragging: vi.fn()
  })
}))

describe('ResizeEdges web gating (#843)', () => {
  beforeEach(() => {
    tauriRef.current = true
    isLinuxRef.current = true
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders region strips on the Linux Tauri desktop', () => {
    const { container } = render(<ResizeEdges />)

    const layer = container.querySelector('.z-\\[9999\\]')
    expect(layer).not.toBeNull()
    expect(container.querySelectorAll('.pointer-events-auto').length).toBe(8)
  })

  it('renders null in a browser even when the platform string looks Linux (Android/iOS)', () => {
    tauriRef.current = false
    isLinuxRef.current = true

    const { container } = render(<ResizeEdges />)
    expect(container.innerHTML).toBe('')
  })

  it('renders null on desktop non-Linux platforms (macOS/Windows)', () => {
    isLinuxRef.current = false

    const { container } = render(<ResizeEdges />)
    expect(container.innerHTML).toBe('')
  })
})
