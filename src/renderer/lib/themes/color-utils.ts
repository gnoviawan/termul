const HEX_COLOR_PATTERN = /^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

function stripHexPrefix(hex: string): string {
  return hex.trim().replace(/^#/, '')
}

function assertValidHex(hex: string): string {
  const normalized = stripHexPrefix(hex)
  if (!HEX_COLOR_PATTERN.test(normalized)) {
    throw new Error(`Invalid hex color: ${hex}`)
  }
  return normalized
}

/** Parse #rgb or #rrggbb to { r, g, b } in 0–255. */
export function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const normalized = assertValidHex(hex)
  if (normalized.length === 3) {
    const r = parseInt(normalized[0] + normalized[0], 16)
    const g = parseInt(normalized[1] + normalized[1], 16)
    const b = parseInt(normalized[2] + normalized[2], 16)
    return { r, g, b }
  }
  if (normalized.length === 6) {
    return {
      r: parseInt(normalized.slice(0, 2), 16),
      g: parseInt(normalized.slice(2, 4), 16),
      b: parseInt(normalized.slice(4, 6), 16)
    }
  }
  throw new Error(`Invalid hex color: ${hex}`)
}

/** CSS variable format used by Tailwind: "H S% L%" without hsl() wrapper. */
export function hexToHslComponents(hex: string): string {
  const { r, g, b } = parseHexColor(hex)
  const rNorm = r / 255
  const gNorm = g / 255
  const bNorm = b / 255
  const max = Math.max(rNorm, gNorm, bNorm)
  const min = Math.min(rNorm, gNorm, bNorm)
  const delta = max - min

  let h = 0
  let s = 0
  const l = (max + min) / 2

  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min)
    switch (max) {
      case rNorm:
        h = ((gNorm - bNorm) / delta + (gNorm < bNorm ? 6 : 0)) / 6
        break
      case gNorm:
        h = ((bNorm - rNorm) / delta + 2) / 6
        break
      default:
        h = ((rNorm - gNorm) / delta + 4) / 6
        break
    }
  }

  const hue = Math.round(h * 360)
  const sat = Math.round(s * 100)
  const light = Math.round(l * 100)
  return `${hue} ${sat}% ${light}%`
}

/** Inverse of `hexToHslComponents`: "H S% L%" to #rrggbb. */
export function hslComponentsToHex(components: string): string {
  const [h, s, l] = components
    .trim()
    .split(/\s+/)
    .map((part) => Number.parseFloat(part))
  const sat = s / 100
  const light = l / 100
  const k = (n: number) => (n + h / 30) % 12
  const a = sat * Math.min(light, 1 - light)
  const channel = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return `#${[channel(0), channel(8), channel(4)]
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

export function mixHex(colorA: string, colorB: string, weightB: number): string {
  const ca = parseHexColor(colorA)
  const cb = parseHexColor(colorB)
  const w = Math.min(1, Math.max(0, weightB))
  const r = Math.round(ca.r * (1 - w) + cb.r * w)
  const g = Math.round(ca.g * (1 - w) + cb.g * w)
  const blue = Math.round(ca.b * (1 - w) + cb.b * w)
  return `#${[r, g, blue].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

export function lightenHex(hex: string, amount: number): string {
  return mixHex(hex, '#ffffff', amount)
}

export function darkenHex(hex: string, amount: number): string {
  return mixHex(hex, '#000000', amount)
}

/** Normalize #rgb / #rrggbb to lowercase #rrggbb. */
export function normalizeHex(hex: string): string {
  let normalized = assertValidHex(hex).toLowerCase()
  if (normalized.length === 3) {
    normalized = normalized
      .split('')
      .map((ch) => ch + ch)
      .join('')
  }
  return `#${normalized}`
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
}

function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHexColor(hex)
  return (
    0.2126 * srgbToLinear(r / 255) + 0.7152 * srgbToLinear(g / 255) + 0.0722 * srgbToLinear(b / 255)
  )
}

/** WCAG 2 contrast ratio between two colors (1–21). */
export function contrastRatio(hexA: string, hexB: string): number {
  const a = relativeLuminance(hexA)
  const b = relativeLuminance(hexB)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

export interface Oklch {
  l: number
  c: number
  h: number
}

export function hexToOklch(hex: string): Oklch {
  const { r, g, b } = parseHexColor(hex)
  const lr = srgbToLinear(r / 255)
  const lg = srgbToLinear(g / 255)
  const lb = srgbToLinear(b / 255)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const h = (Math.atan2(B, A) * 180) / Math.PI
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h }
}

function oklchToLinearRgb({ l, c, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180
  const A = c * Math.cos(rad)
  const B = c * Math.sin(rad)
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_
  ]
}

/** OKLCH to sRGB hex. Out-of-gamut colors keep L and H and lose chroma until they fit. */
export function oklchToHex(color: Oklch): string {
  let c = color.c
  let rgb = oklchToLinearRgb({ ...color, c })
  while (c > 0 && rgb.some((v) => v < -1e-6 || v > 1 + 1e-6)) {
    c = Math.max(0, c - 0.002)
    rgb = oklchToLinearRgb({ ...color, c })
  }
  return `#${rgb
    .map((v) => Math.round(Math.min(1, Math.max(0, linearToSrgb(v))) * 255))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`
}

/**
 * Move `fg` lightness away from `bg` (keeping hue) until it reaches
 * `minRatio`. Returns `fg` unchanged when it already passes.
 */
export function ensureContrast(fg: string, bg: string, minRatio: number): string {
  if (contrastRatio(fg, bg) >= minRatio) return normalizeHex(fg)
  const color = hexToOklch(fg)
  const step = hexToOklch(bg).l < 0.6 ? 0.005 : -0.005
  let candidate = normalizeHex(fg)
  for (let l = color.l + step; l >= 0 && l <= 1; l += step) {
    candidate = oklchToHex({ ...color, l })
    if (contrastRatio(candidate, bg) >= minRatio) return candidate
  }
  return candidate
}

/** True when token color should be stored as an override (strict hex !== base). */
export function shouldOverrideToken(tokenHex: string, baseHex: string): boolean {
  return normalizeHex(tokenHex) !== normalizeHex(baseHex)
}
