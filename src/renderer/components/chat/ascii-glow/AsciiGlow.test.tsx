import { render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const { logFrontendError } = vi.hoisted(() => ({ logFrontendError: vi.fn() }))
vi.mock('@/lib/log-api', () => ({ logFrontendError }))

import { AsciiGlow } from './AsciiGlow'

describe('AsciiGlow', () => {
  it('is a decorative, click-through layer', () => {
    const { container } = render(<AsciiGlow className="-z-10" />)
    const layer = container.firstElementChild
    expect(layer).toHaveAttribute('aria-hidden', 'true')
    expect(layer).toHaveClass('pointer-events-none', '-z-10')
    expect(layer?.querySelector('canvas')).not.toBeNull()
  })

  it('stays empty without WebGPU and logs that once, as info', async () => {
    // jsdom has no navigator.gpu.
    render(<AsciiGlow />)
    render(<AsciiGlow />)
    await waitFor(() => expect(logFrontendError).toHaveBeenCalled())
    expect(logFrontendError).toHaveBeenCalledTimes(1)
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'info', source: 'AsciiGlow' })
    )
  })
})
