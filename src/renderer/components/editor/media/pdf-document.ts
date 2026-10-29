/**
 * The only module that touches pdf.js. It loads `pdfjs-dist` on first use so the
 * library and its worker stay out of the main chunk, and narrows the API to
 * what the viewer draws with. Tests mock this module because jsdom cannot run
 * pdf.js.
 */

import type { PDFDocumentLoadingTask, PDFPageProxy } from 'pdfjs-dist'

export interface PdfPageSize {
  width: number
  height: number
}

/** `promise` resolves `true` once painted, `false` if cancelled first. */
export interface PdfRenderTask {
  readonly promise: Promise<boolean>
  cancel(): void
}

export interface PdfPage {
  /** CSS pixels at scale 1. */
  readonly size: PdfPageSize
  render(canvas: HTMLCanvasElement, scale: number, pixelRatio: number): PdfRenderTask
}

export interface PdfDocument {
  readonly pageCount: number
  /** Placeholder size for pages not fetched yet. */
  readonly firstPageSize: PdfPageSize
  getPage(pageNumber: number): Promise<PdfPage>
  destroy(): void
}

export type PdfOpenFailure = 'password' | 'invalid' | 'unknown'

export type PdfOpenResult =
  | { ok: true; doc: PdfDocument }
  | { ok: false; failure: PdfOpenFailure; errorName: string }

export interface PdfLoad {
  readonly result: Promise<PdfOpenResult>
  /** Stops the load, or tears down the document it produced. Safe to call twice. */
  destroy(): void
}

/** Chromium's practical canvas budget; pdf.js's own viewer uses the same cap. */
const MAX_CANVAS_PIXELS = 2 ** 25

let pdfjs: Promise<typeof import('pdfjs-dist')> | null = null

function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  pdfjs ??= import('pdfjs-dist').then(
    (lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url
      ).href
      return lib
    },
    (error: unknown) => {
      pdfjs = null
      throw error
    }
  )
  return pdfjs
}

function errorName(error: unknown): string {
  return error instanceof Object && 'name' in error && typeof error.name === 'string'
    ? error.name
    : typeof error
}

function classify(error: unknown): PdfOpenFailure {
  switch (errorName(error)) {
    case 'PasswordException':
      return 'password'
    case 'InvalidPDFException':
    case 'FormatError':
      return 'invalid'
    default:
      return 'unknown'
  }
}

function wrapPage(page: PDFPageProxy): PdfPage {
  const base = page.getViewport({ scale: 1 })
  return {
    size: { width: base.width, height: base.height },
    render(canvas, scale, pixelRatio) {
      const cssArea = base.width * base.height * scale * scale
      const ratio = Math.min(pixelRatio, Math.sqrt(MAX_CANVAS_PIXELS / cssArea))
      const viewport = page.getViewport({ scale: scale * ratio })
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      const task = page.render({ canvas, viewport })
      return {
        promise: task.promise.then(
          () => true,
          (error: unknown) => {
            if (errorName(error) === 'RenderingCancelledException') return false
            throw error
          }
        ),
        cancel: () => task.cancel()
      }
    }
  }
}

export function openPdfDocument(bytes: Blob): PdfLoad {
  let task: PDFDocumentLoadingTask | null = null
  let destroyed = false
  const destroy = () => {
    destroyed = true
    void task?.destroy()
  }

  const result = Promise.all([loadPdfjs(), bytes.arrayBuffer()])
    .then(async ([lib, data]): Promise<PdfOpenResult> => {
      task = lib.getDocument({ data: new Uint8Array(data) })
      if (destroyed) void task.destroy()
      const proxy = await task.promise
      const first = wrapPage(await proxy.getPage(1))
      const doc: PdfDocument = {
        pageCount: proxy.numPages,
        firstPageSize: first.size,
        getPage: async (pageNumber) =>
          pageNumber === 1 ? first : wrapPage(await proxy.getPage(pageNumber)),
        destroy
      }
      return { ok: true, doc }
    })
    .catch(
      (error: unknown): PdfOpenResult => ({
        ok: false,
        failure: classify(error),
        errorName: errorName(error)
      })
    )

  return { result, destroy }
}
