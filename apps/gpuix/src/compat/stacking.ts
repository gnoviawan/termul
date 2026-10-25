/**
 * CSS stacking order on GPUI's paint layers.
 *
 * GPUI paints the tree in order, then its deferred draws by priority. With
 * patch gpuix/0011-z-index a positive `zIndex` style puts an element, laid
 * out in place, in that deferred pass at priority `zIndex`, ordered with the
 * `<anchored>` layers, and a layer inside a layer never sorts under it. So
 * one integer scale carries both: a CSS `z-index` is its own priority, and
 * every overlay layer takes the z-index its web counterpart has.
 *
 * On the web every Radix overlay is a `z-50` portal at the end of `<body>`,
 * so it paints over an in-flow `z-50` (the status bar) by DOM order. Here
 * an overlay sits next to its trigger in the tree, so it takes a priority
 * just above 50 instead; the steps keep the order GPUIX's overlays had among
 * themselves (dialogs under menus under tooltips under submenus).
 */

/** The `z-index` of the web's overlay wrappers (`components/ui/*`). */
export const PORTAL_Z = 50

export const LAYER = {
  /** Modal dialogs and the `<body>` portal layer. */
  dialog: PORTAL_Z + 1,
  /** Popovers, menus, selects. */
  popover: PORTAL_Z + 2,
  tooltip: PORTAL_Z + 3,
  submenu: PORTAL_Z + 4
} as const

const Z_TOKEN = /^(-?)z-(\d+|\[(-?\d+)\]|auto)$/

/**
 * The z-index an unprefixed `z-*` class sets: a number, `null` for `z-auto`,
 * or `undefined` for any other token.
 */
export function zIndexToken(token: string): number | null | undefined {
  const match = token.match(Z_TOKEN)
  if (!match) return undefined
  if (match[2] === 'auto') return null
  const value = Number(match[3] ?? match[2])
  return match[1] === '-' ? -value : value
}

/** The `<anchored>` priority of a `fixed` element: its z-index, 0 for `auto`. */
export function fixedPriority(zIndex: number | null): number {
  return zIndex !== null && zIndex > 0 ? zIndex : 0
}
