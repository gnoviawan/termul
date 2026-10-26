/**
 * Mermaid diagrams for the transcript, drawn by the webview helper (`MermaidRenderHost`) and
 * cached by the source's hash for the life of the process: a transcript that remounts a card, or
 * shows the same diagram twice, renders it once. A failed render is not kept, so the next mount
 * tries again. `exportMermaid` answers the card's Download menu with Streamdown's three formats.
 */

import { createHash } from 'node:crypto'
import { useEffect, useState } from 'react'
import { getBrowserHost } from '@/lib/browser-host'
import { isMermaidRenderHost, type MermaidRender } from '../browser/mermaid-render'
import { log } from '../log'

export type MermaidState = { status: 'drawing' } | ({ status: 'done' } & MermaidRender)

const renders = new Map<string, Promise<MermaidRender>>()
const settled = new Map<string, MermaidRender>()
let drawnCount = 0

function keyOf(source: string): string {
  return createHash('sha1').update(source).digest('hex')
}

/** Whether this process can draw diagrams at all; without it a card shows the source. */
export function canDrawMermaid(): boolean {
  return isMermaidRenderHost(getBrowserHost())
}

export function drawMermaid(source: string): Promise<MermaidRender> {
  const key = keyOf(source)
  const cached = renders.get(key)
  if (cached) return cached
  const host = getBrowserHost()
  if (!isMermaidRenderHost(host))
    return Promise.resolve({ ok: false, error: 'no webview helper in this client' })
  const started = performance.now()
  const render = host.renderMermaid(source).then((result) => {
    const ms = Math.round(performance.now() - started)
    if (result.ok) {
      settled.set(key, result)
      drawnCount += 1
      log.info(
        'chat',
        `mermaid.drawn ${JSON.stringify({ ms, nth: drawnCount, width: result.width, height: result.height, pngBytes: result.png.length })}`
      )
    } else {
      renders.delete(key)
      log.warn('chat', `mermaid.failed ${JSON.stringify({ ms, error: result.error })}`)
    }
    return result
  })
  renders.set(key, render)
  return render
}

export type MermaidFormat = 'svg' | 'png' | 'mmd'

export type MermaidExport = { ok: true; data: string | Uint8Array } | { ok: false; error: string }

/** Streamdown rasterizes a downloaded PNG at five times the diagram's size. */
const EXPORT_PNG_SCALE = 5

function dataUrlBytes(url: string): Uint8Array {
  return Uint8Array.from(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
}

/** The file Streamdown's Download menu saves: the SVG mermaid drew, a PNG of it, or the source. */
export async function exportMermaid(source: string, format: MermaidFormat): Promise<MermaidExport> {
  if (format === 'mmd') return { ok: true, data: source }
  if (format === 'svg') {
    const drawn = await drawMermaid(source)
    return drawn.ok ? { ok: true, data: drawn.svg } : drawn
  }
  const host = getBrowserHost()
  if (!isMermaidRenderHost(host)) return { ok: false, error: 'no webview helper in this client' }
  const drawn = await host.renderMermaid(source, { scale: EXPORT_PNG_SCALE })
  return drawn.ok ? { ok: true, data: dataUrlBytes(drawn.png) } : drawn
}

export function useMermaid(source: string): MermaidState {
  const [state, setState] = useState<MermaidState>(() => {
    const hit = settled.get(keyOf(source))
    return hit ? { status: 'done', ...hit } : { status: 'drawing' }
  })
  useEffect(() => {
    let current = true
    const hit = settled.get(keyOf(source))
    if (hit) {
      setState({ status: 'done', ...hit })
      return
    }
    setState({ status: 'drawing' })
    void drawMermaid(source).then((result) => {
      if (current) setState({ status: 'done', ...result })
    })
    return () => {
      current = false
    }
  }, [source])
  return state
}

export function _resetMermaidCacheForTesting(): void {
  renders.clear()
  settled.clear()
  drawnCount = 0
}
