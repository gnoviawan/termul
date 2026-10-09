import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AgentConnectionLamp } from './AgentConnectionLamp'

function lampClass(): string {
  return document.querySelector('svg')?.getAttribute('class') ?? ''
}

describe('AgentConnectionLamp motion', () => {
  it('stops pulsing under reduced motion while reconnecting', () => {
    render(<AgentConnectionLamp connected={false} reconnecting decorative />)

    expect(lampClass()).toContain('animate-pulse')
    expect(lampClass()).toContain('motion-reduce:animate-none')
    expect(lampClass()).toContain('text-warning')
  })

  it.each([
    true,
    false
  ])('does not pulse at all when not reconnecting (connected=%s)', (connected) => {
    render(<AgentConnectionLamp connected={connected} decorative />)

    expect(lampClass()).not.toContain('animate-pulse')
    expect(lampClass()).not.toContain('motion-reduce:animate-none')
  })

  it('keeps the status tone colours: connected, reconnecting and disconnected', () => {
    const { rerender } = render(<AgentConnectionLamp connected decorative />)
    expect(lampClass()).toContain('text-connection')

    rerender(<AgentConnectionLamp connected={false} decorative />)
    expect(lampClass()).toContain('text-destructive')
  })
})
