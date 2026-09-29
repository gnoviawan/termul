import type { ProjectColor } from '@/types/project'
import { hexToOklchComponents, oklchToHex } from './color-utils'

export interface ProjectSwatch {
  l: number
  c: number
  h: number
}

/**
 * Identity swatches (`--project-*`). Keep in sync with index.css.
 * Status-bar fills copy C and H and drop L; chips and graph lanes keep these values.
 */
export const PROJECT_SWATCHES: Record<ProjectColor, ProjectSwatch> = {
  blue: { l: 0.625, c: 0.187, h: 259.7 },
  purple: { l: 0.557, c: 0.251, h: 301.9 },
  green: { l: 0.72, c: 0.192, h: 149.5 },
  yellow: { l: 0.786, c: 0.16, h: 85.7 },
  red: { l: 0.636, c: 0.209, h: 25.4 },
  cyan: { l: 0.801, c: 0.134, h: 209.6 },
  pink: { l: 0.654, c: 0.214, h: 354.1 },
  orange: { l: 0.706, c: 0.186, h: 48.1 },
  gray: { l: 0.551, c: 0.023, h: 264.4 }
}

export function projectSwatchComponents(swatch: ProjectSwatch): string {
  return `${swatch.l} ${swatch.c} ${swatch.h}`
}

export const PROJECT_COLOR_COMPONENTS: Record<ProjectColor, string> = Object.fromEntries(
  (Object.keys(PROJECT_SWATCHES) as ProjectColor[]).map((color) => [
    color,
    projectSwatchComponents(PROJECT_SWATCHES[color])
  ])
) as Record<ProjectColor, string>

/** Chrome-bar fill L. Below the 0.6 light/dark cutoff so near-white ink stays valid. */
export const STATUS_BAR_FILL_L = 0.47

/** Darker step of a project swatch: L drops, C and H stay (C may clamp to sRGB). */
export function statusBarFillComponents(swatch: ProjectSwatch): string {
  return hexToOklchComponents(oklchToHex({ l: STATUS_BAR_FILL_L, c: swatch.c, h: swatch.h }))
}

export function statusBarCssVars(): Record<`--status-bar-${ProjectColor}`, string> {
  const vars = {} as Record<`--status-bar-${ProjectColor}`, string>
  for (const color of Object.keys(PROJECT_SWATCHES) as ProjectColor[]) {
    vars[`--status-bar-${color}`] = statusBarFillComponents(PROJECT_SWATCHES[color])
  }
  return vars
}
