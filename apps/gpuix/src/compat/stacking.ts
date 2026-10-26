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
 * themselves (dialogs under menus under submenus).
 *
 * The web's TooltipContent has no portal: Radix's popper wrapper is a
 * `fixed` box with the content's `z-50`, left next to its trigger. It paints
 * over earlier z-50 layers and under later ones, the `fixed inset-0 z-50`
 * modals included, and under every portalled overlay. A tooltip therefore
 * takes 50 itself: GPUI sorts deferred layers of one priority in tree order.
 */

/** The `z-index` of the web's overlay wrappers (`components/ui/*`). */
const PORTAL_Z = 50

export const LAYER = {
  /** Modal dialogs and the `<body>` portal layer. */
  dialog: PORTAL_Z + 1,
  /** Popovers, menus, selects. */
  popover: PORTAL_Z + 2,
  /** `components/ui/tooltip`, not portalled on the web. */
  tooltip: PORTAL_Z,
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
