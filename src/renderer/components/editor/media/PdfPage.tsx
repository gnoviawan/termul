import { useEffect, useRef } from 'react'
import { logFrontendError } from '@/lib/log-api'
import { basename } from '@/lib/path-basename'
import type { PdfDocument, PdfPageSize, PdfRenderTask } from './pdf-document'

interface PdfPageProps {
  filePath: string
  doc: PdfDocument
  pageNumber: number
  size: PdfPageSize
  scale: number
  inRenderWindow: boolean
  onSize: (pageNumber: number, size: PdfPageSize) => void
}

export function PdfPage({
  filePath,
  doc,
  pageNumber,
  size,
  scale,
  inRenderWindow,
  onSize
}: PdfPageProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    if (!inRenderWindow) {
      host.replaceChildren()
      return
    }
    let cancelled = false
    let task: PdfRenderTask | null = null
    void doc
      .getPage(pageNumber)
      .then(async (page) => {
        if (cancelled) return
        if (page.size.width !== size.width || page.size.height !== size.height) {
          onSize(pageNumber, page.size)
        }
        const canvas = document.createElement('canvas')
        canvas.className = 'block size-full'
        canvas.setAttribute('aria-hidden', 'true')
        task = page.render(canvas, scale, window.devicePixelRatio || 1)
        if ((await task.promise) === 'painted' && !cancelled) host.replaceChildren(canvas)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const message = document.createElement('p')
        message.className =
          'flex size-full items-center justify-center p-4 text-center text-xs text-muted-foreground'
        message.textContent = `Page ${pageNumber} couldn't be rendered.`
        host.replaceChildren(message)
        void logFrontendError({
          level: 'warn',
          source: 'pdfViewer.render',
          message: `Failed to render page ${pageNumber} of '${basename(filePath)}' (${
            error instanceof Error ? error.name : typeof error
          })`
        })
      })
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [doc, pageNumber, scale, inRenderWindow, size, onSize, filePath])

  return (
    <div
      ref={hostRef}
      data-pdf-page={pageNumber}
      role="img"
      aria-label={`Page ${pageNumber}`}
      className="shrink-0 bg-background shadow-md outline outline-1 -outline-offset-1 outline-border"
      style={{ width: Math.round(size.width * scale), height: Math.round(size.height * scale) }}
    />
  )
}
