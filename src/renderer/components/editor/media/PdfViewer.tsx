import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowRightLeft, ZoomIn, ZoomOut } from '@/components/icons'
import { PANEL_HEADER_CLASS, PANEL_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { MEDIA_MAX_BYTES } from '@/lib/media-kind'
import { basename } from '@/lib/path-basename'
import { cn } from '@/lib/utils'
import { PdfPage } from './PdfPage'
import type { PdfDocument, PdfPageSize } from './pdf-document'
import { type PdfFailure, usePdfDocument } from './use-pdf-document'
import {
  isScrolledToEnd,
  locateScrollAnchor,
  type PdfScrollAnchor,
  scrollToAnchor,
  useLastVisibleWidth,
  useNearPages
} from './use-pdf-viewport'

type PdfZoom = { kind: 'fit-width' } | { kind: 'scale'; value: number }

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]
const MIN_SCALE = ZOOM_STEPS[0]
const MAX_SCALE = ZOOM_STEPS[ZOOM_STEPS.length - 1]
const PAGE_GUTTER = 32
const EPSILON = 0.001

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

function nextStep(scale: number, direction: 1 | -1): number {
  const steps = direction === 1 ? ZOOM_STEPS : [...ZOOM_STEPS].reverse()
  return steps.find((step) => direction * (step - scale) > EPSILON) ?? steps[steps.length - 1]
}

function failureMessage(name: string, failure: PdfFailure): string {
  switch (failure.kind) {
    case 'too-large':
      return `${name} is larger than ${MEDIA_MAX_BYTES.pdf / (1024 * 1024)} MB and can't be previewed.`
    case 'password':
      return `${name} is password-protected and can't be previewed.`
    case 'invalid':
      return `${name} is damaged or not a valid PDF.`
    case 'read':
      return `Couldn't read ${name} (${failure.code}).`
    case 'unknown':
      return `Couldn't display ${name}.`
  }
}

export function PdfViewer({
  filePath,
  revision
}: {
  filePath: string
  revision: number
}): React.JSX.Element {
  const state = usePdfDocument(filePath, revision)
  const name = basename(filePath)

  if (state.status === 'loading') {
    return (
      <div role="status" className="flex h-full w-full items-center justify-center bg-background">
        <span className="text-xs text-muted-foreground animate-pulse motion-reduce:animate-none">
          Loading {name}...
        </span>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background p-6">
        <div role="alert" className="flex max-w-sm flex-col items-center gap-2 text-center">
          <AlertTriangle size={20} aria-hidden="true" className="text-muted-foreground" />
          <p className="text-sm text-foreground">{failureMessage(name, state.failure)}</p>
        </div>
      </div>
    )
  }

  return <PdfDocumentView filePath={filePath} doc={state.doc} />
}

const NO_SIZES: ReadonlyMap<number, PdfPageSize> = new Map()

function PdfDocumentView({
  filePath,
  doc
}: {
  filePath: string
  doc: PdfDocument
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState<PdfZoom>({ kind: 'fit-width' })
  const [currentPage, setCurrentPage] = useState(1)
  const anchorRef = useRef<PdfScrollAnchor>({ page: 1, fraction: 0 })

  const [sizes, setSizes] = useState({ doc, byPage: NO_SIZES })
  const byPage = sizes.doc === doc ? sizes.byPage : NO_SIZES
  const handlePageSize = useCallback(
    (pageNumber: number, size: PdfPageSize) => {
      setSizes((previous) => {
        const next = new Map(previous.doc === doc ? previous.byPage : NO_SIZES)
        next.set(pageNumber, size)
        return { doc, byPage: next }
      })
    },
    [doc]
  )

  const width = useLastVisibleWidth(scrollRef)
  const fitScale = width > 0 ? clampScale((width - PAGE_GUTTER) / doc.firstPageSize.width) : 1
  const scale = zoom.kind === 'fit-width' ? fitScale : zoom.value
  const near = useNearPages(scrollRef, doc.pageCount)

  const syncCurrentPage = useCallback(() => {
    const root = scrollRef.current
    if (!root) return
    const anchor = locateScrollAnchor(root, doc.pageCount)
    anchorRef.current = anchor
    setCurrentPage(isScrolledToEnd(root) ? doc.pageCount : anchor.page)
  }, [doc.pageCount])

  const previousScaleRef = useRef(scale)
  useLayoutEffect(() => {
    const root = scrollRef.current
    if (!root || previousScaleRef.current === scale) return
    previousScaleRef.current = scale
    scrollToAnchor(root, anchorRef.current)
  }, [scale])

  useLayoutEffect(syncCurrentPage, [syncCurrentPage])

  const zoomBy = (direction: 1 | -1) =>
    setZoom({ kind: 'scale', value: nextStep(scale, direction) })

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className={cn(PANEL_HEADER_CLASS, 'border-b border-border')}>
        <span
          className="text-xs text-muted-foreground tabular-nums"
          title={`Page ${currentPage} of ${doc.pageCount}`}
        >
          {currentPage} / {doc.pageCount}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={PANEL_ICON_BUTTON_CLASS}
            aria-label="Zoom out"
            title="Zoom out"
            disabled={scale <= MIN_SCALE + EPSILON}
            onClick={() => zoomBy(-1)}
          >
            <ZoomOut size={14} aria-hidden="true" />
          </button>
          <span className="min-w-10 text-center text-xs text-muted-foreground tabular-nums">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            className={PANEL_ICON_BUTTON_CLASS}
            aria-label="Zoom in"
            title="Zoom in"
            disabled={scale >= MAX_SCALE - EPSILON}
            onClick={() => zoomBy(1)}
          >
            <ZoomIn size={14} aria-hidden="true" />
          </button>
          <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />
          <button
            type="button"
            className={cn(
              PANEL_ICON_BUTTON_CLASS,
              zoom.kind === 'fit-width' && 'bg-foreground/[0.06] text-foreground'
            )}
            aria-label="Fit width"
            title="Fit width"
            aria-pressed={zoom.kind === 'fit-width'}
            onClick={() => setZoom({ kind: 'fit-width' })}
          >
            <ArrowRightLeft size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={syncCurrentPage}
        className="relative min-h-0 flex-1 overflow-auto bg-muted/40"
      >
        <div className="flex w-fit min-w-full flex-col items-center gap-3 px-4 py-4">
          {Array.from({ length: doc.pageCount }, (_, index) => {
            const pageNumber = index + 1
            return (
              <PdfPage
                key={pageNumber}
                filePath={filePath}
                doc={doc}
                pageNumber={pageNumber}
                size={byPage.get(pageNumber) ?? doc.firstPageSize}
                scale={scale}
                inRenderWindow={near.has(pageNumber)}
                onSize={handlePageSize}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}
