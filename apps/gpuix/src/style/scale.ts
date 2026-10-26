/**
 * Tailwind v4 theme defaults (node_modules/tailwindcss/theme.css) plus
 * Termul's tailwind.config.ts extensions, in px. One rem is 16px.
 */

export const SPACING_UNIT = 4

/** font-size px and the line-height ratio that comes with it. */
export const FONT_SIZES: Record<string, { size: number; leading?: number }> = {
  xs: { size: 12, leading: 1 / 0.75 },
  sm: { size: 14, leading: 1.25 / 0.875 },
  base: { size: 16, leading: 1.5 },
  lg: { size: 18, leading: 1.75 / 1.125 },
  xl: { size: 20, leading: 1.75 / 1.25 },
  '2xl': { size: 24, leading: 2 / 1.5 },
  '3xl': { size: 30, leading: 2.25 / 1.875 },
  '4xl': { size: 36, leading: 2.5 / 2.25 },
  '5xl': { size: 48, leading: 1 },
  '6xl': { size: 60, leading: 1 },
  '7xl': { size: 72, leading: 1 },
  '8xl': { size: 96, leading: 1 },
  '9xl': { size: 128, leading: 1 },
  // tailwind.config.ts: size-only, so the inherited line-height ratio applies.
  '2xs': { size: 12 },
  '3xs': { size: 12 },
  '4xs': { size: 12 }
}

/** Unitless line-height that `html` gets from Tailwind's preflight. */
export const INHERITED_LEADING = 1.5
export const ROOT_FONT_SIZE = 16

export const FONT_WEIGHTS: Record<string, number> = {
  thin: 100,
  extralight: 200,
  light: 300,
  normal: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  extrabold: 800,
  black: 900
}

/** Tailwind's `tracking-*` scale, in em (rendered by patches zed/0007 + gpuix/0017). */
export const TRACKING_EM: Record<string, string> = {
  tighter: '-0.05',
  tight: '-0.025',
  normal: '0',
  wide: '0.025',
  wider: '0.05',
  widest: '0.1'
}

export const LEADING_RATIOS: Record<string, number> = {
  none: 1,
  tight: 1.25,
  snug: 1.375,
  normal: 1.5,
  relaxed: 1.625,
  loose: 2
}

/** rounded-* in px. sm/md/lg follow tailwind.config.ts (`--radius` minus 4/2/0). */
export function radiusScale(radius: number): Record<string, number> {
  return {
    none: 0,
    xs: 2,
    '': 4,
    sm: radius - 4,
    md: radius - 2,
    lg: radius,
    xl: 12,
    '2xl': 16,
    '3xl': 24,
    '4xl': 32,
    full: 9999
  }
}

export const CONTAINERS: Record<string, number> = {
  '3xs': 256,
  '2xs': 288,
  xs: 320,
  sm: 384,
  md: 448,
  lg: 512,
  xl: 576,
  '2xl': 672,
  '3xl': 768,
  '4xl': 896,
  '5xl': 1024,
  '6xl': 1152,
  '7xl': 1280,
  prose: 65 * 8.5
}

/** Tailwind v4 `--blur-*` (px), the CSS `blur()` standard deviation; bare `blur` is 8px. */
export const BLURS: Record<string, number> = {
  '': 8,
  none: 0,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  '2xl': 40,
  '3xl': 64
}

export const SHADOWS: Record<string, string> = {
  '2xs': '0 1px rgb(0 0 0 / 0.05)',
  xs: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
  '': '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
  sm: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
  md: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
  lg: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  xl: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
  '2xl': '0 25px 50px -12px rgb(0 0 0 / 0.25)',
  none: 'none',
  // tailwind.config.ts boxShadow
  'glow-blue': '0 0 15px oklch(var(--glow-blue) / 0.3)',
  'glow-purple': '0 0 15px oklch(var(--glow-purple) / 0.3)',
  'glow-green': '0 0 15px oklch(var(--glow-green) / 0.3)'
}

export const BREAKPOINTS: Record<string, number> = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  '2xl': 1536
}
