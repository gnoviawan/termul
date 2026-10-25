/**
 * GPUIX twin of `components/canvas/CanvasShell.tsx`: the FigCraft editor for one mount, in a
 * helper webview (`src/browser/canvas-relay.ts`) instead of an iframe, since GPUIX has no
 * iframe. The mount's lifetime, the bridge, the store wiring and the slot tracking are the DOM
 * shell's: the bridge listens first, then the webview loads the editor URL (it carries the canvas
 * token, so it is never logged), and unmounting closes the webview and its WebKit processes.
 *
 * The webview is an X11 child window above everything GPUIX paints, so it follows the browser
 * panes' occlusion: while a dialog, menu or popover is open it moves out of the window, as it
 * does when its tab is not shown (`canvasPlacement`).
 */

import type { CSSProperties } from 'react'
import { useEffect } from 'react'
import { useSlotRect } from '@/components/canvas/use-slot-rect'
import { useNativeWebviewOccluded } from '@/hooks/use-native-webview-occlusion'
import { getAppliedUiZoom } from '@/hooks/use-ui-zoom'
import { getBrowserHost } from '@/lib/browser-host'
import { buildCanvasEmbedUrl, canvasOriginOf, createCanvasBridge } from '@/lib/canvas-bridge'
import { type CanvasMount, useCanvasStore } from '@/stores/canvas-store'
import {
  CANVAS_RELAY_ORIGIN,
  canvasPlacement,
  createCanvasRelayFrame,
  isCanvasCapableHost
} from '../../../browser/canvas-relay'
import { log } from '../../../log'
import { tw } from '../../../style/tw'

interface CanvasShellProps {
  projectId: string
  mount: CanvasMount
  title: string
  /** The visible panel area to cover; `null` keeps the webview offscreen. */
  slot: HTMLElement | null
}

/** Exported as the DOM shell does; the webview's offscreen spot is `canvasPlacement`'s. */
export const OFFSCREEN_FRAME_STYLE: CSSProperties = {
  position: 'fixed',
  left: '-10000px',
  top: '0px',
  width: '1px',
  height: '1px'
}

export function CanvasShell({
  projectId,
  mount,
  slot
}: CanvasShellProps): React.JSX.Element | null {
  const rect = useSlotRect(slot)
  const occluded = useNativeWebviewOccluded()
  const browserHost = getBrowserHost()
  const host = isCanvasCapableHost(browserHost) ? browserHost : null
  const tabId = `canvas-${projectId}-${mount.mountSeq}`

  useEffect(() => {
    if (!host) {
      log.warn('canvas', `no webview host: the canvas of project ${projectId} cannot show`)
      return
    }
    const { mountSeq, info } = mount
    const canvasOrigin = canvasOriginOf(info.baseUrl)
    const relay = createCanvasRelayFrame(host, tabId, canvasOrigin, mountSeq)
    const bridge = createCanvasBridge({
      iframe: relay.frame,
      canvasOrigin,
      mountSeq,
      onEvent: (event) => {
        useCanvasStore.getState().handleBridgeEvent(projectId, mountSeq, event)
      }
    })
    useCanvasStore.getState().attachBridge(projectId, mountSeq, bridge)
    // The web transport's same-origin base is '' and this process has no page to resolve it.
    const url = buildCanvasEmbedUrl(
      { ...info, baseUrl: info.baseUrl === '' ? canvasOrigin : info.baseUrl },
      CANVAS_RELAY_ORIGIN,
      mountSeq
    )
    void host
      .createCanvas(tabId, url, canvasPlacement(null, false, 1))
      .then((created) => (created.success ? host.show(tabId) : created))
    return () => {
      useCanvasStore.getState().detachBridge(projectId, bridge)
      relay.dispose()
      void host.destroy(tabId)
    }
  }, [host, projectId, mount, tabId])

  const { x, y, width, height } = canvasPlacement(rect, occluded, getAppliedUiZoom())
  useEffect(() => {
    if (!host) return
    void host.resize(tabId, { x, y, width, height })
    if (x < 0) host.releaseKeyboard(tabId)
  }, [host, tabId, x, y, width, height])

  if (host || !rect) return null
  return (
    <div
      style={{
        ...tw('flex items-center justify-center bg-background text-sm text-muted-foreground'),
        position: 'fixed',
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      }}
    >
      The canvas needs the webview helper, which runs on Linux under X11.
    </div>
  )
}
