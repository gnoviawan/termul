import { useEffect } from 'react'
import {
  applyColorTheme,
  DEFAULT_COLOR_THEME_ID,
  getEffectiveThemeId,
  normalizeThemeFamilyId
} from '@/lib/themes'
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
}

export function useEffectiveColorThemeId(): string {
  const colorTheme = useColorTheme()
  const appearanceMode = useAppearanceMode()
  const familyId = normalizeThemeFamilyId(colorTheme) || DEFAULT_COLOR_THEME_ID
  return getEffectiveThemeId(familyId, appearanceMode)
}
