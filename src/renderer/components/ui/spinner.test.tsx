import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Spinner } from '@/components/ui/spinner'

const { reducedMotionRef } = vi.hoisted(() => ({
  reducedMotionRef: { current: false as boolean | null }
}))

vi.mock('framer-motion', async (importActual) => {
  const actual = await importActual<typeof import('framer-motion')>()
  return { ...actual, useReducedMotion: () => reducedMotionRef.current }
})

function cometPlayState(container: HTMLElement): string {
  const comet = container.querySelector<HTMLElement>('.tm-comet')
  if (!comet) throw new Error('comet not rendered')
  return comet.style.getPropertyValue('--tm-comet-play')
}

describe('Spinner reduced motion', () => {
  beforeEach(() => {
    reducedMotionRef.current = false
  })

  it('pauses the comet when the user prefers reduced motion', () => {
    reducedMotionRef.current = true
    const { container } = render(<Spinner />)

    expect(cometPlayState(container)).toBe('paused')
  })

  it('runs the comet otherwise', () => {
    reducedMotionRef.current = false
    const { container } = render(<Spinner />)

    expect(cometPlayState(container)).toBe('running')
  })

  it('runs when the preference is unknown', () => {
    reducedMotionRef.current = null
    const { container } = render(<Spinner />)

    expect(cometPlayState(container)).toBe('running')
  })
})
