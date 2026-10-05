import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NeedsYouButton, RunningMark } from './indicators'

// Issue #859: beside a long project name, the non-shrinking "N need you"
// badge and "Running" label squeezed the project name span to a single
// letter. Both indicators must now shrink/truncate themselves (min-w-0) so
// the flex-1 name span keeps its width.
describe('sidebar indicators (#859)', () => {
  it('NeedsYouButton shrinks and clips its label instead of starving the project name', () => {
    render(<NeedsYouButton count={3} onOpen={() => {}} />)

    const button = screen.getByRole('button', { name: /3 need you/i })
    expect(button.className).toContain('min-w-0')
    expect(button.className).toContain('max-w-24')
    expect(button.className).not.toContain('shrink-0')
    // Full label stays accessible via the title/aria-label.
    expect(button).toHaveAttribute('title', '3 need you')
  })

  it('RunningMark shrinks instead of holding a fixed-width slot', () => {
    render(<RunningMark />)

    const mark = screen.getByTitle('An agent chat is still running')
    expect(mark.className).toContain('min-w-0')
    expect(mark.className).not.toContain('shrink-0')
  })
})
