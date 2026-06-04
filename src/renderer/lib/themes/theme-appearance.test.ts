import { describe, expect, it } from 'vitest'
import {
  getEffectiveThemeId,
  getPickerApplySettings,
  normalizeThemeFamilyId
} from './theme-appearance'

describe('theme-appearance', () => {
  it('normalizes light theme ids to family', () => {
    expect(normalizeThemeFamilyId('catppuccin-light')).toBe('catppuccin')
    expect(normalizeThemeFamilyId('catppuccin')).toBe('catppuccin')
  })

  it('resolves effective theme id from family and mode', () => {
    expect(getEffectiveThemeId('dracula', 'dark')).toBe('dracula')
    expect(getEffectiveThemeId('dracula', 'light')).toBe('dracula-light')
  })

  it('maps picker rows to persisted settings', () => {
    expect(getPickerApplySettings('one-dark-light')).toEqual({
      colorTheme: 'one-dark',
      appearanceMode: 'light'
    })
    expect(getPickerApplySettings('nord')).toEqual({
      colorTheme: 'nord',
      appearanceMode: 'dark'
    })
  })
})
