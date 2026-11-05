import { createContext, useContext } from 'react'

/**
 * Where anchored popovers and menus portal to. The default (no provider) is
 * `undefined`, which Radix reads as `document.body`: the app never sets it.
 * The design-system canvas sets it to a layer inside its zoomed world so a
 * flyout scales with the preview it belongs to.
 */
export const PortalContainerContext = createContext<HTMLElement | null>(null)

/** The portal target, or `undefined` for Radix's default (`document.body`). */
export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext) ?? undefined
}
