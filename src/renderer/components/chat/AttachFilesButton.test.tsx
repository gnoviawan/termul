import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AttachFilesButton } from './AttachFilesButton'

describe('AttachFilesButton', () => {
  it('exposes accessible label and fires click', () => {
    const onClick = vi.fn()
    render(
      <TooltipProvider>
        <AttachFilesButton onClick={onClick} />
      </TooltipProvider>
    )
    const button = screen.getByRole('button', { name: 'Attach files' })
    button.click()
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('can be disabled', () => {
    render(
      <TooltipProvider>
        <AttachFilesButton onClick={() => {}} disabled />
      </TooltipProvider>
    )
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeDisabled()
  })
})
