import { useEffect } from 'react'
import {
  applyColorTheme,
  DEFAULT_COLOR_THEME_ID,
  getEffectiveThemeId,
  normalizeThemeFamilyId
} from '@/lib/themes'
import { getSystemAppearance } from '@/lib/themes/theme-appearance'
import { useAppearanceMode, useAppSettingsLoaded, useColorTheme } from '@/stores/app-settings-store'
import { useThemePickerOpen } from '@/stores/theme-picker-store'

/** Keep the applied (persisted) color theme in sync — skips while the picker is previewing. */
export function useAppliedColorThemeSync(): void {
  const isLoaded = useAppSettingsLoaded()
  const colorTheme = useColorTheme()
  const appearanceMode = useAppearanceMode()
  const isPickerOpen = useThemePickerOpen()

  useEffect(() => {
    if (!isLoaded || isPickerOpen) return
    const familyId = normalizeThemeFamilyId(colorTheme) || DEFAULT_COLOR_THEME_ID
    const themeId = getEffectiveThemeId(familyId, appearanceMode)
    applyColorTheme(themeId)
  }, [isLoaded, colorTheme, appearanceMode, isPickerOpen])

  useEffect(() => {
    if (!isLoaded || isPickerOpen || appearanceMode !== 'system') return

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (): void => {
      const familyId = normalizeThemeFamilyId(colorTheme) || DEFAULT_COLOR_THEME_ID
      applyColorTheme(getEffectiveThemeId(familyId, 'system'))
    }

    media.addEventListener('change', handleChange)
    return () => media.removeEventListener('change', handleChange)
  }, [isLoaded, colorTheme, appearanceMode, isPickerOpen])
}

export function useEffectiveColorThemeId(): string {
  const colorTheme = useColorTheme()
  const appearanceMode = useAppearanceMode()
  const familyId = normalizeThemeFamilyId(colorTheme) || DEFAULT_COLOR_THEME_ID
  return getEffectiveThemeId(familyId, appearanceMode)
}

/** For tests and diagnostics. */
export function resolveEffectiveAppearance(
  appearanceMode: 'light' | 'dark' | 'system'
): 'light' | 'dark' {
  return appearanceMode === 'system' ? getSystemAppearance() : appearanceMode
}
