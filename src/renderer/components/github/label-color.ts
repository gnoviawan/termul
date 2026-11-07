import { useSyncExternalStore } from 'react'
import {
  ensureContrast,
  mixHex,
  oklchComponentsToHex,
  TEXT_CONTRAST_MIN
} from '@/lib/themes/color-utils'
import { readCssTokenComponents } from '@/lib/themes/read-css-token'

const HEX_COLOR = /^[0-9a-f]{6}$/i

/** Wash ~14% and edge ~45% of the label colour, as 8-digit hex alpha suffixes. */
const WASH_ALPHA = 0.14
const WASH_SUFFIX = '24'
const EDGE_SUFFIX = '73'

// The contrast search steps lightness; a list re-renders its chips on every poll.
const CACHE_LIMIT = 512
const cache = new Map<string, LabelColors>()

export interface LabelColors {
  /** Text and dot ink: the label colour moved to 4.5:1 against its washed chip. */
  ink: string
  wash: string
  edge: string
}

/**
 * A GitHub label colour made readable on `surfaceHex`. GitHub colours are
 * picked for github.com's own surfaces, so the ink keeps the hue but moves
 * in lightness until it reaches text contrast on the washed chip. `null` for
 * a colour GitHub did not send as six hex digits: the chip stays neutral.
 */
export function labelColors(color: string, surfaceHex: string): LabelColors | null {
  if (!HEX_COLOR.test(color) || !HEX_COLOR.test(surfaceHex.replace(/^#/, ''))) return null
  const key = `${color}|${surfaceHex}`
  const cached = cache.get(key)
  if (cached) return cached
  const hex = `#${color.toLowerCase()}`
  const chip = mixHex(surfaceHex, hex, WASH_ALPHA)
  const colors = {
    ink: ensureContrast(hex, chip, TEXT_CONTRAST_MIN),
    wash: `${hex}${WASH_SUFFIX}`,
    edge: `${hex}${EDGE_SUFFIX}`
  }
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(key, colors)
  return colors
}

type SurfaceToken = '--background' | '--popover'

// applyColorTheme writes the tokens inline on <html>; one observer serves every chip.
const listeners = new Set<() => void>()
let observer: MutationObserver | null = null

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!observer && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => {
      for (const notify of listeners) notify()
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class']
    })
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      observer?.disconnect()
      observer = null
    }
  }
}

/** The current theme's hex for a surface token, or '' before a theme is applied. */
export function useSurfaceHex(token: SurfaceToken): string {
  const components = useSyncExternalStore(subscribe, () => readCssTokenComponents(token))
  return components ? oklchComponentsToHex(components) : ''
}
