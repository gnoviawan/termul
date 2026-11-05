import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SwitchStates } from './tokens'

describe('SwitchStates', () => {
  it('gives every switch specimen its own id and label', () => {
    render(<SwitchStates />)
    const switches = screen.getAllByRole('switch')
    const ids = switches.map((node) => node.id)
    expect(ids.every(Boolean)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    for (const node of switches) {
      const label = document.querySelector(`label[for="${CSS.escape(node.id)}"]`)
      expect(label).not.toBeNull()
    }
  })
})
