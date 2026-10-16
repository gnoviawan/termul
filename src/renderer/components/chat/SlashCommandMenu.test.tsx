import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SlashCommandMenu } from './SlashCommandMenu'
import { buildSlashSections } from './slash-menu-model'

function renderMenu(commands: Parameters<typeof buildSlashSections>[0]['commands']): void {
  const sections = buildSlashSections({ commands, configOptions: [], modes: null, filter: '' })
  render(<SlashCommandMenu sections={sections} onSelect={() => {}} />)
}

describe('SlashCommandMenu', () => {
  it("shows a command's input hint after its name", () => {
    renderMenu([
      { name: 'review', description: 'Review a pull request', input: { hint: 'pr-number' } }
    ])

    expect(screen.getByRole('option')).toHaveTextContent('/reviewpr-numberReview a pull request')
  })

  it('shows no hint for a command without input', () => {
    renderMenu([{ name: 'compact', description: 'Compact the conversation', input: null }])

    expect(screen.getByRole('option')).toHaveTextContent(/^\/compactCompact the conversation$/)
  })
})
