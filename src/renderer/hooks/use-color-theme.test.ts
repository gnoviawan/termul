import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyColorTheme,
  DEFAULT_COLOR_THEME_ID,
  getEffectiveThemeId,
  normalizeThemeFamilyId
} from '@/lib/themes'
import { useAppliedColorThemeSync } from './use-color-theme'

const mocks = vi.hoisted(() => ({
  useAppSettingsLoaded: vi.fn(),
  useColorTheme: vi.fn(),
  useAppearanceMode: vi.fn(),
  useThemePickerOpen: vi.fn(),
  applyColorTheme: vi.fn()
}))

vi.mock('@/stores/app-settings-store', () => ({
  useAppSettingsLoaded: mocks.useAppSettingsLoaded,
  useColorTheme: mocks.useColorTheme,
  useAppearanceMode: mocks.useAppearanceMode
}))

vi.mock('@/stores/theme-picker-store', () => ({
  useThemePickerOpen: mocks.useThemePickerOpen
}))

vi.mock('@/lib/themes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/themes')>()
  return {
    ...actual,
    applyColorTheme: mocks.applyColorTheme
  }
})

describe('useAppliedColorThemeSync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useAppSettingsLoaded.mockReturnValue(true)
    mocks.useColorTheme.mockReturnValue('termul')
    mocks.useAppearanceMode.mockReturnValue('dark')
    mocks.useThemePickerOpen.mockReturnValue(false)
  })

  it('does not apply the persisted theme while the picker is previewing', async () => {
    mocks.useThemePickerOpen.mockReturnValue(true)

    renderHook(() => useAppliedColorThemeSync())

    await Promise.resolve()
    expect(applyColorTheme).not.toHaveBeenCalled()
  })

  it('falls back to the default theme family for empty persisted theme ids', async () => {
    mocks.useColorTheme.mockReturnValue('')
    mocks.useAppearanceMode.mockReturnValue('light')

    renderHook(() => useAppliedColorThemeSync())

    const familyId = normalizeThemeFamilyId('') || DEFAULT_COLOR_THEME_ID
    await waitFor(() => {
      expect(applyColorTheme).toHaveBeenCalledWith(getEffectiveThemeId(familyId, 'light'))
    })
  })
})
