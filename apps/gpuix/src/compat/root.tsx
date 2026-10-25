/**
 * The boundary between a native GPUIX tree and shared components rendered
 * through compat: binds the renderer for the DOM adapters, mounts the overlay
 * layer portals land in, and paints the document root (`body` in index.css).
 */

import { type PublicInstance, type RenderOptions, useGpuixRequired } from '@gpuix/react'
import { Fragment, type ReactNode, useCallback, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { dragPreview, hitTransparent, subscribeDragPreview } from './dnd'
import { type CompatRenderer, bindCompatRenderer } from './dom-node'
import { bubbleNativeFocus, noteWindowKey, windowKeyEvent } from './events'
import { parkHiddenPanes } from './park'
import { setOverlayLayer } from './react-dom'
import { compatThemeId, compatTw, subscribeCompatTheme } from './translate'
import { LAYER } from './stacking'
import { syncViewport } from './viewport'
import { sentinelPress } from './window-press'

const OVERLAY = {
  position: 'absolute',
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  pointerEvents: 'none',
  // `document.body`'s portals paint over the page's own z-50 layers, as they do on the web.
  zIndex: LAYER.dialog
} as const

/** Sees every press in the window for `document`/`window` listeners (`window-press.ts`). */
const PRESS_SENTINEL = { position: 'absolute', left: 0, top: 0, width: 0, height: 0 } as const

export interface CompatRootProps {
  children: ReactNode
  /** Runs once with the renderer before shared content mounts (font registration). */
  onRenderer?: (renderer: ReturnType<typeof useGpuixRequired>) => void
}

export function CompatRoot({ children, onRenderer }: CompatRootProps): ReactNode {
  const renderer = useGpuixRequired()
  const [layer, setLayer] = useState<PublicInstance | null>(null)
  const [ready, setReady] = useState(false)
  const layerRef = useCallback((instance: PublicInstance | null) => {
    setLayer(instance)
    return hitTransparent(instance as { id: number } | null)
  }, [])
  useLayoutEffect(() => {
    bindCompatRenderer(renderer as unknown as CompatRenderer)
    const parking = parkHiddenPanes(renderer)
    onRenderer?.(renderer)
    syncViewport(renderer)
    setReady(true)
    return () => {
      parking.uninstall()
      bindCompatRenderer(null)
    }
  }, [renderer, onRenderer])
  useLayoutEffect(() => {
    setOverlayLayer(layer)
    return () => setOverlayLayer(null)
  }, [layer])
  // Translations are fixed at element creation, so a theme switch remounts the tree.
  const themeId = useSyncExternalStore(subscribeCompatTheme, compatThemeId)
  const root = compatTw()('relative h-full w-full bg-background text-foreground font-sans')
  return (
    <div style={{ ...root, fontSize: 16, lineHeight: 24 }} onLayout={() => syncViewport(renderer)}>
      {ready && layer ? <Fragment key={themeId}>{children}</Fragment> : null}
      <div ref={layerRef} style={OVERLAY} />
      <div ref={hitTransparent as never} style={PRESS_SENTINEL} onMouseDownOutside={sentinelPress} />
      <DragPreviewBox />
    </div>
  )
}

/** The DOM's drag image, reduced to the source's outline following the pointer. */
function DragPreviewBox(): ReactNode {
  const box = useSyncExternalStore(subscribeDragPreview, dragPreview)
  if (!box) return null
  const look = compatTw()('rounded-sm border border-primary/40 bg-primary/10')
  return (
    <div
      ref={hitTransparent as never}
      style={{
        ...look,
        position: 'absolute',
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
        pointerEvents: 'none'
      }}
    />
  )
}

function hostPlatform(): string | undefined {
  return (globalThis as { process?: { platform?: string } }).process?.platform
}

/**
 * Render options a compat tree needs: window key events reach `window`
 * listeners, and on Linux text antialiases in grayscale like Chromium's.
 * GPUI draws subpixel (LCD) text into an opaque window, whose colour fringes
 * make small labels read warm or blue next to the web (C8); it draws grayscale
 * into a transparent one. CompatRoot paints `bg-background` over the whole
 * window, so the window still looks opaque.
 */
export const compatRenderOptions: Pick<
  RenderOptions,
  'onEvent' | 'onKeyDown' | 'onKeyUp' | 'keyboardFocusDim' | 'windowBackground'
> = {
  keyboardFocusDim: false,
  onEvent: bubbleNativeFocus,
  ...(hostPlatform() === 'linux' ? { windowBackground: 'transparent' } : {}),
  onKeyDown: (event) => {
    const dom = windowKeyEvent('keydown', event)
    ;(globalThis as { window?: EventTarget }).window?.dispatchEvent(dom)
    noteWindowKey(event, dom.defaultPrevented)
  },
  onKeyUp: (event) => {
    ;(globalThis as { window?: EventTarget }).window?.dispatchEvent(windowKeyEvent('keyup', event))
  }
}
