/**
 * The boundary between a native GPUIX tree and shared components rendered
 * through compat: binds the renderer for the DOM adapters, mounts the overlay
 * layer portals land in, and paints the document root (`body` in index.css).
 */

import { type PublicInstance, type RenderOptions, useGpuixRequired } from '@gpuix/react'
import { Fragment, type ReactNode, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { type CompatRenderer, bindCompatRenderer } from './dom-node'
import { windowKeyEvent } from './events'
import { setOverlayLayer } from './react-dom'
import { compatThemeId, compatTw, subscribeCompatTheme } from './translate'
import { observeViewport } from './viewport'

const OVERLAY = {
  position: 'absolute',
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  pointerEvents: 'none'
} as const

export interface CompatRootProps {
  children: ReactNode
  /** Runs once with the renderer before shared content mounts (font registration). */
  onRenderer?: (renderer: ReturnType<typeof useGpuixRequired>) => void
}

export function CompatRoot({ children, onRenderer }: CompatRootProps): ReactNode {
  const renderer = useGpuixRequired()
  const [layer, setLayer] = useState<PublicInstance | null>(null)
  const [ready, setReady] = useState(false)
  useLayoutEffect(() => {
    bindCompatRenderer(renderer as unknown as CompatRenderer)
    onRenderer?.(renderer)
    const unobserve = observeViewport(renderer)
    setReady(true)
    return () => {
      unobserve()
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
    <div style={{ ...root, fontSize: 16, lineHeight: 24 }}>
      {ready && layer ? <Fragment key={themeId}>{children}</Fragment> : null}
      <div ref={setLayer} style={OVERLAY} />
    </div>
  )
}

/** Render options a compat tree needs: window key events reach `window` listeners. */
export const compatRenderOptions: Pick<RenderOptions, 'onKeyDown' | 'onKeyUp' | 'keyboardFocusDim'> = {
  keyboardFocusDim: false,
  onKeyDown: (event) => {
    ;(globalThis as { window?: EventTarget }).window?.dispatchEvent(windowKeyEvent('keydown', event))
  },
  onKeyUp: (event) => {
    ;(globalThis as { window?: EventTarget }).window?.dispatchEvent(windowKeyEvent('keyup', event))
  }
}
