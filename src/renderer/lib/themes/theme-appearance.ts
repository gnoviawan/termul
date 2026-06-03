export type AppearanceMode = 'light' | 'dark' | 'system'
export type ThemeAppearance = 'light' | 'dark'

export function getSystemAppearance(): ThemeAppearance {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return 'dark'
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function resolveAppearanceMode(mode: AppearanceMode): ThemeAppearance {
  return mode === 'system' ? getSystemAppearance() : mode
}

export function getLightThemeId(familyId: string): string {
  return `${familyId}-light`
}

export function normalizeThemeFamilyId(themeId: string): string {
  return themeId.endsWith('-light') ? themeId.slice(0, -6) : themeId
}

export function getEffectiveThemeId(familyId: string, appearanceMode: AppearanceMode): string {
  const family = normalizeThemeFamilyId(familyId)
  const resolved = resolveAppearanceMode(appearanceMode)
  return resolved === 'light' ? getLightThemeId(family) : family
}

/** Map a bundled theme row id to persisted settings (Q7-A + Q11-A). */
export function getPickerApplySettings(themeId: string): {
  colorTheme: string
  appearanceMode: Exclude<AppearanceMode, 'system'>
} {
  if (themeId.endsWith('-light')) {
    return {
      colorTheme: normalizeThemeFamilyId(themeId),
      appearanceMode: 'light'
    }
  }
  return {
    colorTheme: themeId,
    appearanceMode: 'dark'
  }
}
