import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import * as appSettingsHooks from '@/hooks/use-app-settings'
import { resetShellLayoutStoreForTests, useShellLayoutStore } from '@/stores/shell-layout-store'
import { RailToggleButton } from './RailToggleButton'

const { mockToastError } = vi.hoisted(() => ({ mockToastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: mockToastError } }))

const updatePanelVisibility = vi.fn((panel: string, visible: boolean) => {
  if (panel === 'sidebarVisible') useShellLayoutStore.getState().setRailExpanded(visible)
  return Promise.resolve()
})

function renderToggle() {
  render(
    <TooltipProvider delayDuration={0}>
      <RailToggleButton />
    </TooltipProvider>
  )
  return screen.getByRole('button', { name: 'Expand or collapse projects' })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetShellLayoutStoreForTests()
  useShellLayoutStore.setState({ status: 'unavailable' })
  vi.spyOn(appSettingsHooks, 'useUpdatePanelVisibility').mockReturnValue(updatePanelVisibility)
})

describe('RailToggleButton', () => {
  it('keeps a stable name and follows the Rail state', async () => {
    const toggle = renderToggle()
    expect(toggle).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(toggle)
    expect(updatePanelVisibility).toHaveBeenCalledWith('sidebarVisible', false)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-pressed', 'false'))
  })

  it('does not take the keycap surface while expanded: pressed means expanded, not "you are here"', () => {
    expect(renderToggle()).not.toHaveClass('keycap')
  })

  it('swaps the glyph: collapse when expanded, expand when collapsed', async () => {
    const toggle = renderToggle()
    expect(toggle.querySelector('[data-termul-icon="PanelLeftCollapse"]')).not.toBeNull()

    fireEvent.click(toggle)
    await waitFor(() =>
      expect(toggle.querySelector('[data-termul-icon="PanelLeftExpand"]')).not.toBeNull()
    )
  })

  it('names the next action and its shortcut in the tooltip', async () => {
    const toggle = renderToggle()
    fireEvent.focus(toggle)
    expect((await screen.findAllByText(/^Collapse projects \(.*B\)$/)).length).toBeGreaterThan(0)
  })

  it('toasts when saving fails', async () => {
    updatePanelVisibility.mockRejectedValueOnce(new Error('disk full'))
    fireEvent.click(renderToggle())
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('disk full'))
  })
})
