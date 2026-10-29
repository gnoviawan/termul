import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PdfViewer } from './PdfViewer'
import type { PdfDocument, PdfLoad, PdfOpenResult, PdfRenderTask } from './pdf-document'

const { mockReadMediaBytes, mockOpenPdfDocument, mockLog } = vi.hoisted(() => ({
  mockReadMediaBytes: vi.fn(),
  mockOpenPdfDocument: vi.fn(),
  mockLog: vi.fn()
}))

vi.mock('@/lib/media-bytes-api', () => ({ readMediaBytes: mockReadMediaBytes }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: mockLog }))
vi.mock('./pdf-document', () => ({ openPdfDocument: mockOpenPdfDocument }))

const FILE = '/work/out/report.pdf'
const PAGE = { width: 600, height: 800 }
const BYTES = new Blob(['%PDF-1.7'], { type: 'application/pdf' })

interface FakeDoc extends PdfDocument {
  destroy: ReturnType<typeof vi.fn>
  renders: Array<{ page: number; scale: number; pixelRatio: number }>
  cancels: number[]
}

function fakeDoc(pageCount: number, paint: () => Promise<boolean> = async () => true): FakeDoc {
  const doc: FakeDoc = {
    pageCount,
    firstPageSize: PAGE,
    renders: [],
    cancels: [],
    destroy: vi.fn(),
    getPage: async (page) => ({
      size: PAGE,
      render: (_canvas, scale, pixelRatio): PdfRenderTask => {
        doc.renders.push({ page, scale, pixelRatio })
        return { promise: paint(), cancel: () => doc.cancels.push(page) }
      }
    })
  }
  return doc
}

function deferredLoad(): PdfLoad & {
  destroy: ReturnType<typeof vi.fn>
  resolve: (result: PdfOpenResult) => void
} {
  let resolve!: (result: PdfOpenResult) => void
  const result = new Promise<PdfOpenResult>((r) => {
    resolve = r
  })
  return { result, destroy: vi.fn(), resolve }
}

function opens(result: PdfOpenResult): void {
  mockOpenPdfDocument.mockImplementationOnce(() => ({
    result: Promise.resolve(result),
    destroy: vi.fn()
  }))
}

let nearPages: (page: number) => boolean = () => true

class NearPagesObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    const page = Number((target as HTMLElement).dataset.pdfPage)
    const entry = { target, isIntersecting: nearPages(page) } as IntersectionObserverEntry
    queueMicrotask(() => this.callback([entry], this as unknown as IntersectionObserver))
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

const canvasCount = (container: HTMLElement) => container.querySelectorAll('canvas').length
const pageIndicator = () => screen.getByTitle(/^Page \d+ of \d+$/).textContent

const PADDING = 16
const GAP = 12

const layout: Record<string, PropertyDescriptor> = {
  clientWidth: { configurable: true, get: () => 632 },
  offsetHeight: {
    configurable: true,
    get(this: HTMLElement) {
      return Number.parseFloat(this.style.height) || 0
    }
  },
  offsetTop: {
    configurable: true,
    get(this: HTMLElement) {
      const page = Number(this.dataset.pdfPage)
      return page ? PADDING + (page - 1) * (this.offsetHeight + GAP) : 0
    }
  }
}
const originalLayout = Object.fromEntries(
  Object.keys(layout).map((key) => [
    key,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)
  ])
)
const originalObserver = window.IntersectionObserver

function scrollViewTo(top: number): void {
  const scroller = screen.getByRole('img', { name: 'Page 1' }).parentElement?.parentElement
  if (!scroller) throw new Error('no scroll container')
  scroller.scrollTop = top
  fireEvent.scroll(scroller)
}

describe('PdfViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nearPages = () => true
    window.IntersectionObserver = NearPagesObserver as unknown as typeof IntersectionObserver
    for (const [key, descriptor] of Object.entries(layout)) {
      Object.defineProperty(HTMLElement.prototype, key, descriptor)
    }
    mockReadMediaBytes.mockResolvedValue({ success: true, data: BYTES })
  })

  afterEach(() => {
    window.IntersectionObserver = originalObserver
    for (const [key, descriptor] of Object.entries(originalLayout)) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor)
    }
  })

  it('opens the file bytes and paints every page near the viewport at fit width', async () => {
    const doc = fakeDoc(3)
    opens({ ok: true, doc })
    const { container } = render(<PdfViewer filePath={FILE} revision={0} />)
    await settle()

    expect(mockReadMediaBytes).toHaveBeenCalledWith(FILE)
    expect(mockOpenPdfDocument).toHaveBeenCalledWith(BYTES)
    expect(pageIndicator()).toBe('1 / 3')
    expect(screen.getByText('100%')).toBeInTheDocument()
    expect(canvasCount(container)).toBe(3)
    expect(doc.renders.map((r) => [r.page, r.scale])).toEqual([
      [1, 1],
      [2, 1],
      [3, 1]
    ])
  })

  it('leaves pages away from the viewport unpainted', async () => {
    nearPages = (page) => page <= 2
    const doc = fakeDoc(5)
    opens({ ok: true, doc })
    const { container } = render(<PdfViewer filePath={FILE} revision={0} />)
    await settle()

    expect(pageIndicator()).toBe('1 / 5')
    expect(canvasCount(container)).toBe(2)
    expect(doc.renders.map((r) => r.page)).toEqual([1, 2])
  })

  it('tracks the page under the top of the viewport and keeps it in place across zoom', async () => {
    opens({ ok: true, doc: fakeDoc(5) })
    render(<PdfViewer filePath={FILE} revision={0} />)
    await settle()

    scrollViewTo(1740)
    expect(pageIndicator()).toBe('3 / 5')

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    await settle()
    const scroller = screen.getByRole('img', { name: 'Page 1' }).parentElement?.parentElement
    expect(scroller?.scrollTop).toBe(1910)
    expect(pageIndicator()).toBe('3 / 5')
  })

  it('zooms by steps and returns to fit width', async () => {
    nearPages = (page) => page === 1
    const doc = fakeDoc(2)
    opens({ ok: true, doc })
    render(<PdfViewer filePath={FILE} revision={0} />)
    await settle()
    const slot = screen.getByRole('img', { name: 'Page 1' })
    expect(slot.style.width).toBe('600px')

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    await settle()
    expect(screen.getByText('110%')).toBeInTheDocument()
    expect(slot.style.width).toBe('660px')
    expect(slot.style.height).toBe('880px')
    expect(screen.getByRole('button', { name: 'Fit width' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(doc.renders.at(-1)).toMatchObject({ page: 1, scale: 1.1 })

    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    await settle()
    expect(screen.getByText('90%')).toBeInTheDocument()
    expect(slot.style.width).toBe('540px')

    fireEvent.click(screen.getByRole('button', { name: 'Fit width' }))
    await settle()
    expect(screen.getByText('100%')).toBeInTheDocument()
    expect(slot.style.width).toBe('600px')
  })

  it.each([
    [
      'a read error',
      { success: false, error: 'missing', code: 'NOT_FOUND' },
      "Couldn't read report.pdf (NOT_FOUND)."
    ],
    [
      'a file over the PDF cap',
      { success: false, error: 'big', code: 'FILE_TOO_LARGE' },
      "report.pdf is larger than 50 MB and can't be previewed."
    ]
  ])('shows %s inline with the file name', async (_case, read, message) => {
    mockReadMediaBytes.mockResolvedValueOnce(read)
    render(<PdfViewer filePath={FILE} revision={0} />)
    await settle()

    expect(screen.getByRole('alert')).toHaveTextContent(message)
    expect(mockOpenPdfDocument).not.toHaveBeenCalled()
  })

  it.each([
    ['password', 'PasswordException', "report.pdf is password-protected and can't be previewed."],
    ['invalid', 'InvalidPDFException', 'report.pdf is damaged or not a valid PDF.'],
    ['unknown', 'TypeError', "Couldn't display report.pdf."]
  ] as const)('shows the %s open failure and logs its error class', async (failure, errorName, message) => {
    opens({ ok: false, failure, errorName })
    render(<PdfViewer filePath={FILE} revision={0} />)
    await settle()

    expect(screen.getByRole('alert')).toHaveTextContent(message)
    expect(mockLog).toHaveBeenCalledWith({
      level: 'warn',
      source: 'pdfViewer.open',
      message: `Failed to open PDF 'report.pdf' (${errorName})`
    })
  })

  it('keeps the old document on screen until the new revision opens, then destroys it', async () => {
    const first = fakeDoc(3)
    opens({ ok: true, doc: first })
    const { rerender, unmount } = render(<PdfViewer filePath={FILE} revision={0} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))

    const next = deferredLoad()
    mockOpenPdfDocument.mockImplementationOnce(() => next)
    rerender(<PdfViewer filePath={FILE} revision={1} />)
    await settle()
    expect(mockReadMediaBytes).toHaveBeenCalledTimes(2)
    expect(pageIndicator()).toBe('1 / 3')
    expect(first.destroy).toHaveBeenCalledTimes(0)

    const second = fakeDoc(5)
    await act(async () => next.resolve({ ok: true, doc: second }))
    await settle()
    expect(pageIndicator()).toBe('1 / 5')
    expect(screen.getByText('110%')).toBeInTheDocument()
    expect(first.destroy).toHaveBeenCalledTimes(1)
    expect(second.destroy).toHaveBeenCalledTimes(0)

    unmount()
    expect(second.destroy).toHaveBeenCalledTimes(1)
  })

  it('abandons a load that a newer revision overtakes', async () => {
    const stale = deferredLoad()
    mockOpenPdfDocument.mockImplementationOnce(() => stale)
    const { rerender } = render(<PdfViewer filePath={FILE} revision={0} />)
    await settle()

    opens({ ok: true, doc: fakeDoc(2) })
    rerender(<PdfViewer filePath={FILE} revision={1} />)
    await settle()

    expect(stale.destroy).toHaveBeenCalledTimes(1)
    expect(pageIndicator()).toBe('1 / 2')
  })

  it('cancels page renders still in flight on unmount', async () => {
    nearPages = (page) => page <= 2
    const doc = fakeDoc(4, () => new Promise<boolean>(() => {}))
    opens({ ok: true, doc })
    const { container, unmount } = render(<PdfViewer filePath={FILE} revision={0} />)
    await settle()
    expect(canvasCount(container)).toBe(0)

    unmount()
    expect(doc.cancels).toEqual([1, 2])
    expect(doc.destroy).toHaveBeenCalledTimes(1)
  })
})
