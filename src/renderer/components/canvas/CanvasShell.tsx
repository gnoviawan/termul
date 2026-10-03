/**
 * Canvas shell (OpenPencil canvas mode, AD-3): the single iframe surface on
 * every client. The embed URL comes verbatim from the canvas open response
 * (desktop: the loopback daemon URL with the raw-concat `?embed=vscode`
 * query; web: the same-origin `/canvas/<id>/?embed=vscode&ct=<token>` proxy
 * path) and is used as-is — never re-encoded.
 *
 * No `sandbox` attribute: the cross-origin editor page needs its own
 * postMessage bridge to the parent (sandboxing would break it), and
 * clipboard writes are relayed through the host (`op-shell/copy`) anyway.
 * `allow="clipboard-read; clipboard-write"` mirrors the OpenPencil embed.
 */

import type { RefObject } from 'react'

interface CanvasShellProps {
  embedUrl: string
  title: string
  iframeRef: RefObject<HTMLIFrameElement>
}

export function CanvasShell({ embedUrl, title, iframeRef }: CanvasShellProps): React.JSX.Element {
  return (
    <iframe
      ref={iframeRef}
      src={embedUrl}
      title={title}
      allow="clipboard-read; clipboard-write"
      className="h-full w-full border-0 block"
    />
  )
}
