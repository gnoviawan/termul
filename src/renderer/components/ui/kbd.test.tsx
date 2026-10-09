import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { KBD_CLASS, Kbd } from './kbd'

describe('Kbd', () => {
  it('renders a hairline key chip', () => {
    render(<Kbd>Ctrl+1</Kbd>)
    const kbd = screen.getByText('Ctrl+1')
    expect(kbd.tagName).toBe('KBD')
    expect(kbd).toHaveClass(...KBD_CLASS.split(' '))
  })

  it('merges call-site layout classes', () => {
    render(<Kbd className="inline-flex h-4.5 px-1">Esc</Kbd>)
    expect(screen.getByText('Esc')).toHaveClass('inline-flex', 'h-4.5', 'px-1', 'border-border')
  })
})
