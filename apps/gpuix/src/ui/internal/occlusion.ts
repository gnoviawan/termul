/**
 * Webview occlusion for the ui twins. Native browser webviews paint above GPUIX, so an open
 * dialog, menu, popover or select must hide them, as the web primitives do through
 * `hooks/use-native-webview-occlusion.ts`. Boot hands that hook in (`provideWebviewOcclusion`)
 * instead of the twins importing it, so the twins stay free of the renderer module graph: their
 * unit tests load them under plain Bun. Without a provider the hook does nothing.
 */

type OcclusionHook = (open: boolean) => void

let occlusionHook: OcclusionHook = () => {}

/** Call once before the first render; the hook must not change while the tree is mounted. */
export function provideWebviewOcclusion(hook: OcclusionHook): void {
  occlusionHook = hook
}

/** Hide native webviews while `open`. */
export function useWebviewOcclusion(open: boolean): void {
  occlusionHook(open)
}
