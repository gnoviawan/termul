/**
 * What a host adds to the browser-pane set to draw mermaid diagrams: the helper renders them in a
 * hidden webview with the web client's mermaid and answers with a PNG (`native/webview-host/src/mermaid.rs`).
 */

import type { BrowserHost } from '@/lib/browser-host'

export type MermaidRender =
  | { ok: true; png: string; width: number; height: number }
  | { ok: false; error: string }

export interface MermaidRenderHost {
  renderMermaid(source: string): Promise<MermaidRender>
}

export function isMermaidRenderHost(
  host: BrowserHost | null
): host is BrowserHost & MermaidRenderHost {
  return host !== null && 'renderMermaid' in host
}
