import type { ProjectColor } from '@/types/project'
import { hexToOklchComponents, oklchToHex } from './color-utils'

/**
 * Identity swatches (`--project-*`). Keep in sync with index.css.
 * Status-bar fills copy C and H and drop L; chips and graph lanes keep these values.
 */
export const PROJECT_COLOR_COMPONENTS: Record<ProjectColor, string> = {
  blue: '0.625 0.187 259.7',
  purple: '0.557 0.251 301.9',
  green: '0.72 0.192 149.5',
  yellow: '0.786 0.16 85.7',
  red: '0.636 0.209 25.4',
  cyan: '0.801 0.134 209.6',
  pink: '0.654 0.214 354.1',
  orange: '0.706 0.186 48.1',
  gray: '0.551 0.023 264.4'
}

/** Chrome-bar fill L. Below the 0.6 light/dark cutoff so near-white ink stays valid. */
export const STATUS_BAR_FILL_L = 0.47

/** Darker step of a project swatch: L drops, C and H stay (C may clamp to sRGB). */
export function statusBarFillComponents(projectComponents: string): string {
  const parts = projectComponents.trim().split(/\s+/)
  const c = Number.parseFloat(parts[1] ?? '0')
  const h = Number.parseFloat(parts[2] ?? '0')
  return hexToOklchComponents(oklchToHex({ l: STATUS_BAR_FILL_L, c, h }))
}

export function statusBarCssVars(): Record<`--status-bar-${ProjectColor}`, string> {
  const vars = {} as Record<`--status-bar-${ProjectColor}`, string>
  for (const color of Object.keys(PROJECT_COLOR_COMPONENTS) as ProjectColor[]) {
    vars[`--status-bar-${color}`] = statusBarFillComponents(PROJECT_COLOR_COMPONENTS[color])
  }
  return vars
}
