import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useContextBarSettingsStore } from '@/stores/context-bar-settings-store'
import { DEFAULT_CONTEXT_BAR_SETTINGS } from '@/types/settings'
import { ContextBarSettingsPopover } from './ContextBarSettingsPopover'

const { mockUpdateContextBarSetting } = vi.hoisted(() => ({
  mockUpdateContextBarSetting: vi.fn()
}))

vi.mock('@/hooks/use-context-bar-settings', () => ({
  useUpdateContextBarSetting: () => mockUpdateContextBarSetting
}))

describe('ContextBarSettingsPopover', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useContextBarSettingsStore.setState({
      settings: { ...DEFAULT_CONTEXT_BAR_SETTINGS },
      isLoaded: true
    })
  })

  it('renders the context bar settings popover trigger', () => {
    render(<ContextBarSettingsPopover />)

    expect(screen.getByRole('button', { name: 'Context bar settings' })).toBeInTheDocument()
  })

  it('gives the trigger a 44px border box on coarse pointers only (#881)', () => {
    render(<ContextBarSettingsPopover />)
    const button = screen.getByRole('button', { name: 'Context bar settings' })
    expect(button.className).toContain('size-6')
    expect(button.className).not.toContain('max-md:')
    expect(button.className).toContain('pointer-coarse:size-11')
    expect(button.className).toContain('pointer-coarse:-my-2.5')
    expect(button.className).toContain('pointer-coarse:-translate-y-2.5')
    expect(button.className).toContain('pointer-coarse:after:inset-0')
    // 12px glyph stays put; the wrapper cancels the button's upward shift.
    expect(button.querySelector('span')?.className).toContain('pointer-coarse:translate-y-2.5')
    expect(button.querySelector('span')?.className).not.toContain('max-md:')
  })

  it('opens the popover and dispatches updates for each switch', () => {
    render(<ContextBarSettingsPopover />)

    fireEvent.click(screen.getByRole('button', { name: 'Context bar settings' }))

    expect(screen.getByText('Show in Context Bar')).toBeInTheDocument()

    const toggleCases: Array<[string, string]> = [
      ['Git Branch', 'showGitBranch'],
      ['Git Status', 'showGitStatus'],
      ['Working Directory', 'showWorkingDirectory'],
      ['Exit Code', 'showExitCode']
    ]

    toggleCases.forEach(([label, key]) => {
      const row = screen.getByText(label).closest('div')
      expect(row).not.toBeNull()

      const toggle = within(row as HTMLElement).getByRole('switch')
      fireEvent.click(toggle)

      expect(mockUpdateContextBarSetting).toHaveBeenCalledWith(key)
    })

    expect(mockUpdateContextBarSetting).toHaveBeenCalledTimes(toggleCases.length)
  })
})
