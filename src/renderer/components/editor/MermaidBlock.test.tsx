import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyColorTheme } from '@/lib/themes'
import { MermaidBlock } from './MermaidBlock'

const { mockInitialize, mockRender } = vi.hoisted(() => ({
  mockInitialize: vi.fn(),
  mockRender: vi.fn(async (id: string) => ({
    svg: `<svg data-render-id="${id}"><text>diagram</text></svg>`
  }))
}))

vi.mock('mermaid', () => ({
  default: {
    initialize: mockInitialize,
    render: mockRender
  }
}))

describe('MermaidBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.documentElement.className = ''
    document.documentElement.removeAttribute('style')
  })

  it('does not render twice for the same theme state from event and class mutation callbacks', async () => {
    render(<MermaidBlock source="graph TD; A-->B" />)

    await waitFor(() => {
      expect(mockRender).toHaveBeenCalledTimes(1)
    })

    act(() => {
      applyColorTheme('dracula')
    })

    await waitFor(() => {
      expect(mockRender).toHaveBeenCalledTimes(2)
    })

    await Promise.resolve()
    expect(mockRender).toHaveBeenCalledTimes(2)
  })
})
