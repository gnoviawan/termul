import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SettingsSwitchRow } from './SettingsSwitchRow'

describe('SettingsSwitchRow', () => {
  it('names the switch after the label and reports the next state', () => {
    const onToggle = vi.fn()
    render(
      <SettingsSwitchRow
        label="Enable auto save"
        description="Save after typing stops"
        checked={false}
        onToggle={onToggle}
      />
    )
    expect(screen.getByText('Save after typing stops')).toBeInTheDocument()
    const toggle = screen.getByRole('switch', { name: 'Enable auto save' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    const descriptionId = toggle.getAttribute('aria-describedby')
    expect(descriptionId).toBeTruthy()
    expect(document.getElementById(descriptionId ?? '')).toHaveTextContent(
      'Save after typing stops'
    )
    fireEvent.click(toggle)
    expect(onToggle).toHaveBeenCalledWith(true)
  })
})
