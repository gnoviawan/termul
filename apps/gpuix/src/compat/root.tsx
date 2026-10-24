/**
 * The boundary between a native GPUIX tree and shared components rendered
 * through compat: binds the renderer for the DOM adapters, mounts the overlay
 * layer portals land in, and paints the document root (`body` in index.css).
 */

import { type PublicInstance, type RenderOptions, useGpuixRequired } from '@gpuix/react'
import { Fragment, type ReactNode, useCallback, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { busyTolerantReads } from './busy-ui'
import { dragPreview, hitTransparent, subscribeDragPreview } from './dnd'
import { type CompatRenderer, bindCompatRenderer } from './dom-node'
import { parkHiddenPanes } from './park'
import { windowKeyEvent } from './events'
import { setOverlayLayer } from './react-dom'
import { compatThemeId, compatTw, subscribeCompatTheme } from './translate'
import { syncViewport } from './viewport'

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
  const layerRef = useCallback((instance: PublicInstance | null) => {
    setLayer(instance)
    return hitTransparent(instance as { id: number } | null)
  }, [])
  useLayoutEffect(() => {
    bindCompatRenderer(busyTolerantReads(renderer as unknown as CompatRenderer))
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
