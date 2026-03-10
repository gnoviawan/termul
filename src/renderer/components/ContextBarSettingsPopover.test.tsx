import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { ContextBarSettingsPopover } from './ContextBarSettingsPopover'
import { useContextBarSettingsStore } from '@/stores/context-bar-settings-store'
import { DEFAULT_CONTEXT_BAR_SETTINGS } from '@/types/settings'

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

    expect(
      screen.getByRole('button', { name: 'Context bar settings' })
    ).toBeInTheDocument()
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
