import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AiPromptDialog } from './AiPromptDialog'

describe('AiPromptDialog copy button', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(async () => undefined) }
    })
  })

  it('keeps the success label color when the copied state is hovered', async () => {
    render(
      <AiPromptDialog
        isOpen
        onClose={() => undefined}
        context={{
          sourceBranch: 'main',
          worktreePath: '/repo',
          projectName: 'Cloud Hello'
        }}
      />
    )

    const button = screen.getByRole('button', { name: 'Copy Prompt' })
    fireEvent.click(button)

    const copied = await screen.findByRole('button', { name: 'Copied!' })
    expect(copied.className).toContain('text-success')
    expect(copied.className).toContain('hover:text-success')
    expect(copied.className).not.toContain('hover:text-accent-foreground')
  })
})
