import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FileMentionMenu } from './FileMentionMenu'
import { buildMentionSections, type MentionMatch } from './mention-menu-model'

const match = (relPath: string, ignored = false): MentionMatch => ({
  relPath,
  absPath: `/root/${relPath}`,
  name: relPath.split('/').pop() ?? relPath,
  ignored
})

describe('FileMentionMenu', () => {
  it('dims ignored rows and fires onSelect with the MentionMatch payload', () => {
    const sections = buildMentionSections({
      matches: [match('src/auth.ts', false), match('node_modules/pkg/index.js', true)],
      recents: [],
      filter: 'a'
    })
    const onSelect = vi.fn()
    render(<FileMentionMenu sections={sections} onSelect={onSelect} />)

    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(2)
    expect(options[1].className).toContain('opacity-50')
    expect(options[0].className).not.toContain('opacity-50')

    fireEvent.mouseDown(options[0])
    expect(onSelect).toHaveBeenCalledWith(match('src/auth.ts', false))
  })

  it('renders the empty label when there are no sections', () => {
    const onSelect = vi.fn()
    render(<FileMentionMenu sections={[]} onSelect={onSelect} />)
    expect(screen.getByText('No matching files.')).toBeInTheDocument()
  })
})
