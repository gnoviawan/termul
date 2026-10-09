import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ModeMenuList } from './mode-menu'

describe('ModeMenuList', () => {
  it('moves focus with ArrowDown and ArrowUp', () => {
    render(
      <ModeMenuList
        modes={[
          { id: 'ask', name: 'Ask' },
          { id: 'agent', name: 'Agent' }
        ]}
        selectedId="ask"
        touch={false}
        onPick={vi.fn()}
      />
    )

    const ask = screen.getByRole('button', { name: 'Ask' })
    const agent = screen.getByRole('button', { name: 'Agent' })
    ask.focus()
    fireEvent.keyDown(ask, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(agent)
    fireEvent.keyDown(agent, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(ask)
  })
})
