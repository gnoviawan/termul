/**
 * The figcraft editor iframe for one mount. Owns the bridge for that mount:
 * the bridge starts listening first, then `src` is set programmatically so
 * the URL (it carries the `ct` token) never appears in the DOM attributes or
 * in a log. Remounting (a new `mountSeq`) is a new component instance.
 *
 * Rendered by `CanvasMountLayer`, never inside a tab: the iframe stays put in
 * the DOM and is laid over its panel's slot while the tab shows, or kept as
 * an offscreen 1×1 visible frame while it does not (AD-19). `display:none`
 * would stall the editor's message handling (figcraft SPIKE.md), so the
 * hidden state only moves and shrinks it.
 *
 * No `sandbox`: the editor needs its own origin's storage and the parent
 * `postMessage` channel, both of which a sandbox would cut.
 */

import { type CSSProperties, useEffect, useRef, useState } from 'react'
import { buildCanvasEmbedUrl, canvasOriginOf, createCanvasBridge } from '@/lib/canvas-bridge'
import { type CanvasMount, useCanvasStore } from '@/stores/canvas-store'

interface CanvasShellProps {
  projectId: string
  mount: CanvasMount
  title: string
  /** The visible panel area to cover; `null` keeps the frame offscreen. */
  slot: HTMLElement | null
}

/** Off the viewport but still a laid-out, visible 1×1 frame. */
export const OFFSCREEN_FRAME_STYLE: CSSProperties = {
  position: 'fixed',
  left: '-10000px',
  top: '0px',
  width: '1px',
  height: '1px'
}

interface SlotRect {
  left: number
  top: number
  width: number
  height: number
}

function sameRect(a: SlotRect | null, b: SlotRect): boolean {
  return (
    a !== null &&
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height
  )
}

/** The slot's viewport rectangle, followed every frame while there is a
 * slot: pane resizes, splits and sidebar moves all shift it. */
function useSlotRect(slot: HTMLElement | null): SlotRect | null {
  const [rect, setRect] = useState<SlotRect | null>(null)
  useEffect(() => {
    if (!slot) {
      setRect(null)
      return
    }
    let frame = 0
    let last: SlotRect | null = null
    const follow = (): void => {
      const box = slot.getBoundingClientRect()
      const next = { left: box.left, top: box.top, width: box.width, height: box.height }
      if (!sameRect(last, next)) {
        last = next
        setRect(next)
      }
      frame = requestAnimationFrame(follow)
    }
    follow()
    return () => cancelAnimationFrame(frame)
  }, [slot])
  return slot ? rect : null
}

export function CanvasShell({
  projectId,
  mount,
  title,
  slot
}: CanvasShellProps): React.JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const rect = useSlotRect(slot)

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    const { mountSeq, info } = mount
    const store = useCanvasStore.getState()
    const bridge = createCanvasBridge({
      iframe,
      canvasOrigin: canvasOriginOf(info.baseUrl),
      mountSeq,
      onEvent: (event) => {
        useCanvasStore.getState().handleBridgeEvent(projectId, mountSeq, event)
      }
    })
    store.attachBridge(projectId, mountSeq, bridge)
    iframe.src = buildCanvasEmbedUrl(info, window.location.origin, mountSeq)
    return () => {
      useCanvasStore.getState().detachBridge(projectId, bridge)
    }
  }, [projectId, mount])

  const shown = rect !== null
  const style: CSSProperties = shown
    ? {
        position: 'fixed',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`
      }
    : OFFSCREEN_FRAME_STYLE

  return (
    <iframe
      ref={iframeRef}
      title={title}
      allow="clipboard-read; clipboard-write"
      className="z-10 block border-0"
      style={style}
      tabIndex={shown ? undefined : -1}
      aria-hidden={shown ? undefined : true}
      data-canvas-project={projectId}
      data-canvas-mount-seq={mount.mountSeq}
      data-canvas-frame-state={shown ? 'visible' : 'hidden'}
    />
  )
}
