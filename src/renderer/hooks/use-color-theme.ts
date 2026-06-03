import { useEffect } from 'react'
import { applyColorTheme, DEFAULT_COLOR_THEME_ID, getColorThemeDefinition } from '@/lib/themes'
import { useAppSettingsLoaded, useColorTheme } from '@/stores/app-settings-store'
import { useThemePickerOpen } from '@/stores/theme-picker-store'

/** Keep the applied (persisted) color theme in sync — skips while the picker is previewing. */
export function useAppliedColorThemeSync(): void {
  const isLoaded = useAppSettingsLoaded()
  const colorTheme = useColorTheme()
  const isPickerOpen = useThemePickerOpen()

  useEffect(() => {
    if (!isLoaded || isPickerOpen) return
    const themeId = getColorThemeDefinition(colorTheme).id ?? DEFAULT_COLOR_THEME_ID
    applyColorTheme(themeId)
  }, [isLoaded, colorTheme, isPickerOpen])
}
