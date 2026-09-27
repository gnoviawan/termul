import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AlertCircle, Search } from './index'

describe('Termul functional icons', () => {
  it('inherits the UI color and accepts size and stroke overrides', () => {
    const { container } = render(
      <>
        <Search size={16} strokeWidth={2} />
        <AlertCircle aria-label="Connection warning" />
      </>
    )
    const [search, alert] = container.querySelectorAll('svg')

    expect(search).toHaveAttribute('width', '16')
    expect(search).toHaveAttribute('height', '16')
    expect(search).toHaveAttribute('stroke-width', '2')
    expect(search).toHaveAttribute('stroke', 'currentColor')
    expect(search.innerHTML).not.toContain('#252525')
    expect(search).toHaveAttribute('aria-hidden', 'true')
    expect(alert).toHaveAttribute('aria-label', 'Connection warning')
    expect(alert).not.toHaveAttribute('aria-hidden', 'true')
  })

  it('scopes internal SVG references per instance', () => {
    const { container } = render(
      <>
        <Search />
        <Search />
      </>
    )
    const [first, second] = container.querySelectorAll('svg[data-termul-icon="Search"]')
    const firstClip = first.querySelector('g')?.getAttribute('clip-path')
    const secondClip = second.querySelector('g')?.getAttribute('clip-path')

    expect(firstClip).toBeTruthy()
    expect(secondClip).toBeTruthy()
    expect(firstClip).not.toBe(secondClip)
  })
})
