/**
 * What a host adds to the browser-pane set to draw mermaid diagrams: the helper renders them in a
 * hidden webview with the web client's mermaid and answers with a PNG and the SVG (`native/webview-host/src/mermaid.rs`).
 */

import type { BrowserHost } from '@/lib/browser-host'

/** A drawn diagram: the PNG (a data URL) at `width`x`height` CSS pixels, and the SVG mermaid drew. */
export type MermaidRender =
  | { ok: true; png: string; svg: string; width: number; height: number }
  | { ok: false; error: string }

export interface MermaidRenderHost {
  /** `scale` is the PNG's pixels per CSS pixel; the helper draws at 2 without it. */
  renderMermaid(source: string, options?: { scale?: number }): Promise<MermaidRender>
}

export function isMermaidRenderHost(
  host: BrowserHost | null
): host is BrowserHost & MermaidRenderHost {
  return host !== null && 'renderMermaid' in host
}
