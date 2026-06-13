import { darkenHex, lightenHex, mixHex } from './color-utils'
import type { ThemeAppearance, ThemePalette } from './types'

export interface DerivedSurfaces {
  card: string
  secondary: string
  muted: string
  border: string
  sidebar: string
}

/** Derive elevated surface colors from base palette for dark or light chrome. */
export function deriveSurfaces(
  palette: ThemePalette,
  appearance: ThemeAppearance
): DerivedSurfaces {
  if (appearance === 'light') {
    return {
      card: darkenHex(palette.neutral, 0.02),
      secondary: darkenHex(palette.neutral, 0.04),
      muted: darkenHex(palette.neutral, 0.06),
      border: darkenHex(palette.neutral, 0.12),
      sidebar: mixHex(palette.neutral, '#000000', 0.03)
    }
  }

  return {
    card: lightenHex(palette.neutral, 0.06),
    secondary: lightenHex(palette.neutral, 0.08),
    muted: lightenHex(palette.neutral, 0.11),
    border: lightenHex(palette.neutral, 0.14),
    sidebar: mixHex(palette.neutral, '#000000', 0.04)
  }
}
