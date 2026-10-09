import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { AnimatedMenuContent, menuMotion } from './animated-menu-content'

if (typeof document.elementFromPoint !== 'function') {
  Object.defineProperty(document, 'elementFromPoint', {
    value: () => null,
    configurable: true,
    writable: true
  })
}

afterEach(() => {
  for (const name of ['--duration-fast', '--duration-quick', '--scale-medium']) {
    document.documentElement.style.removeProperty(name)
  }
})

describe('menuMotion (transitions.dev menu dropdown, on the motion tokens)', () => {
  it('opens 250ms from scale 0.97 and closes 150ms to scale 0.99 on the smooth-out curve', () => {
    const m = menuMotion(false)
    expect(m.initial).toEqual({ opacity: 0, scale: 0.97 })
    expect(m.open).toEqual({ opacity: 1, scale: 1 })
    expect(m.closed).toEqual({ opacity: 0, scale: 0.99 })
    expect(m.openTransition).toEqual({ duration: 0.25, ease: [0.22, 1, 0.36, 1] })
    expect(m.closeTransition).toEqual({ duration: 0.15, ease: [0.22, 1, 0.36, 1] })
  })

  it('has no travel distance (the dropdown recipe scales only)', () => {
    const m = menuMotion(false)
    for (const state of [m.initial, m.open, m.closed]) {
      expect(state).not.toHaveProperty('y')
      expect(state).not.toHaveProperty('x')
    }
  })

  it('reduced motion is a 150ms fade with no scale', () => {
    const m = menuMotion(true)
    expect(m.initial).toEqual({ opacity: 0 })
    expect(m.open).toEqual({ opacity: 1 })
    expect(m.closed).toEqual({ opacity: 0 })
    expect(m.openTransition.duration).toBe(0.15)
    expect(m.closeTransition.duration).toBe(0.15)
  })

  it('reads the durations and scale from the CSS motion tokens', () => {
    document.documentElement.style.setProperty('--duration-fast', '300ms')
    document.documentElement.style.setProperty('--duration-quick', '0.1s')
    document.documentElement.style.setProperty('--scale-medium', '0.95')
    const m = menuMotion(false)
    expect(m.openTransition.duration).toBe(0.3)
    expect(m.closeTransition.duration).toBe(0.1)
    expect(m.initial).toEqual({ opacity: 0, scale: 0.95 })
  })
})

function Harness({ open }: { open: boolean }): React.JSX.Element {
  return (
    <Popover open={open}>
      <PopoverTrigger>Open</PopoverTrigger>
      <AnimatedMenuContent open={open} align="start" side="top">
        <p>Menu body</p>
      </AnimatedMenuContent>
    </Popover>
  )
}

describe('AnimatedMenuContent', () => {
  it('grows from the trigger and turns off the global Radix keyframes', () => {
    render(<Harness open />)
    const body = screen.getByText('Menu body')
    const content = body.closest('[data-menu-motion]') as HTMLElement
    expect(content).toHaveAttribute('data-menu-motion', 'dropdown')
    expect(content).toHaveClass('termul-popover-transition')
    const layer = body.parentElement as HTMLElement
    expect(layer.style.transformOrigin).toBe('var(--radix-popover-content-transform-origin)')
  })

  it('stays mounted while it closes, then unmounts', async () => {
    const { rerender } = render(<Harness open />)
    rerender(<Harness open={false} />)
    // Still in the DOM: the close animation plays (and can reverse if reopened).
    expect(screen.getByText('Menu body')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('Menu body')).toBeNull())
  })

  it('renders nothing before the first open', () => {
    render(<Harness open={false} />)
    expect(screen.queryByText('Menu body')).toBeNull()
  })
})
