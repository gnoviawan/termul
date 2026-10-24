/**
 * Whether this process can host browser panes, and with which helper binary. The helper embeds
 * webviews as X11 child windows of the GPUIX window, so it needs GPUI on X11. GPUI picks Wayland
 * whenever `WAYLAND_DISPLAY` is set (it checks it before `DISPLAY`), so a Wayland session gets no
 * browser panes rather than webviews that cannot attach; XWayland would need GPUI itself on X11.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'

export const WEBVIEW_HOST_BIN = 'termul-webview-host'

export type BrowserSupport =
  | { kind: 'x11'; binary: string }
  | { kind: 'unsupported'; reason: string }

export function detectBrowserSupport(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  bundleDir: string,
  exists: (file: string) => boolean = existsSync
): BrowserSupport {
  if (platform !== 'linux') {
    return {
      kind: 'unsupported',
      reason: `browser panes are Linux X11 only on GPUIX (this is ${platform})`
    }
  }
  if (env.WAYLAND_DISPLAY) {
    return {
      kind: 'unsupported',
      reason: `GPUI runs on Wayland here (WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY}) and the webview helper attaches to X11 windows only`
    }
  }
  if (!env.DISPLAY) return { kind: 'unsupported', reason: 'no X11 DISPLAY' }
  const binary = env.TERMUL_WEBVIEW_HOST_BIN || path.join(bundleDir, WEBVIEW_HOST_BIN)
  if (!exists(binary)) {
    return { kind: 'unsupported', reason: `${binary} is missing (bun run build builds it)` }
  }
  return { kind: 'x11', binary }
}
