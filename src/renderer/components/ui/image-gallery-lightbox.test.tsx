import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  armMobileOverlayBackStack,
  pressSystemBack,
  waitForSentinelDepth
} from '@/lib/test-utils/overlay-back-stack'
import { readOverlaySentinelDepth } from '@/stores/overlay-stack-store'
import { type GalleryImage, ImageGalleryLightbox } from './image-gallery-lightbox'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

const SLIDE_WIDTH = 400

const IMAGES: GalleryImage[] = [1, 2, 3, 4].map((n) => ({
  src: `blob:termul/${n}`,
  alt: `shot ${n}`,
  fileName: `shot-${n}.png`
}))

function Harness({
  images = IMAGES,
  onDownload = () => {}
}: {
  images?: GalleryImage[]
  onDownload?: (image: GalleryImage) => void
}): React.JSX.Element {
  const [open, setOpen] = useState<{ index: number; opener: HTMLElement } | null>(null)
  return (
    <>
      {images.map((image, index) => (
        <button
          key={image.src}
          type="button"
          onClick={(event) => setOpen({ index, opener: event.currentTarget })}
        >
          {`Open ${image.alt}`}
        </button>
      ))}
      <button
        type="button"
        onClick={(event) => setOpen({ index: 99, opener: event.currentTarget })}
      >
        Open out of range
      </button>
      <ImageGalleryLightbox
        images={images}
        openIndex={open?.index ?? null}
        opener={open?.opener ?? null}
        onClose={() => setOpen(null)}
        onDownload={onDownload}
      />
    </>
  )
}

function counter(): string | null {
  return screen.queryByText(/^\d+ of \d+$/)?.textContent ?? null
}

describe('ui/image-gallery-lightbox', () => {
  const originalScrollTo = Element.prototype.scrollTo
  const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')

  beforeEach(() => {
    // jsdom has no layout: give every element a slide width and make scrollTo
    // land instantly, firing the scroll the track listens to.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => SLIDE_WIDTH
    })
    Element.prototype.scrollTo = function (this: Element, options?: ScrollToOptions | number) {
      if (typeof options === 'object') this.scrollLeft = options.left ?? 0
      fireEvent.scroll(this)
    } as typeof Element.prototype.scrollTo
  })

  afterEach(() => {
    Element.prototype.scrollTo = originalScrollTo
    if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth)
  })

  it('opens at the tapped image with an "n of m" counter', () => {
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: 'Open shot 2' }))

    expect(screen.getByRole('dialog')).toHaveAccessibleName('shot 2')
    expect(counter()).toBe('2 of 4')
    expect(screen.getByTestId('image-gallery-track').scrollLeft).toBe(SLIDE_WIDTH)
    expect(screen.getAllByRole('group').map((slide) => slide.getAttribute('aria-label'))).toEqual([
      '1 of 4',
      '2 of 4',
      '3 of 4',
      '4 of 4'
    ])
  })

  it('moves between images with the arrow keys and stops at the ends', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Open shot 3' }))

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(counter()).toBe('4 of 4')
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(counter()).toBe('4 of 4')
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(counter()).toBe('1 of 4')
  })

  it('moves with the previous and next buttons, disabling each at its end', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Open shot 1' }))
    const previous = screen.getByRole('button', { name: 'Previous image' })
    const next = screen.getByRole('button', { name: 'Next image' })

    expect(previous).toBeDisabled()
    fireEvent.click(next)
    expect(counter()).toBe('2 of 4')
    expect(previous).toBeEnabled()
    fireEvent.click(previous)
    expect(counter()).toBe('1 of 4')
  })

  it('follows a swipe on the track', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Open shot 1' }))
    const track = screen.getByTestId('image-gallery-track')

    track.scrollLeft = 3 * SLIDE_WIDTH
    fireEvent.scroll(track)

    expect(counter()).toBe('4 of 4')
    expect(screen.getByRole('button', { name: 'Next image' })).toBeDisabled()
  })

  it('downloads the image on screen', () => {
    const onDownload = vi.fn()
    render(<Harness onDownload={onDownload} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open shot 2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }))

    fireEvent.click(screen.getByRole('button', { name: 'Download shot-3.png' }))

    expect(onDownload).toHaveBeenCalledWith(IMAGES[2])
  })

  it('clamps an out-of-range open index to the last image', () => {
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: 'Open out of range' }))

    expect(counter()).toBe('4 of 4')
    expect(screen.getByRole('button', { name: 'Download shot-4.png' })).toBeInTheDocument()
  })

  it('starts again at the tapped image after it was closed elsewhere', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Open shot 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close image' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Open shot 4' }))

    expect(counter()).toBe('4 of 4')
  })

  it('closes on a click on the black area around the image, not on the image', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Open shot 2' }))
    const [, slide] = screen.getAllByRole('group')

    fireEvent.click(screen.getByAltText('shot 2'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.click(slide)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('labels the carousel and announces the counter', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Open shot 1' }))

    expect(screen.getByRole('region', { name: 'Images' })).toHaveAttribute(
      'aria-roledescription',
      'carousel'
    )
    expect(screen.getByText('1 of 4')).toHaveAttribute('aria-live', 'polite')
  })

  it('jumps without smooth scrolling under reduced motion', () => {
    const scrolls: Array<ScrollToOptions | number | undefined> = []
    const instantScrollTo = Element.prototype.scrollTo
    Element.prototype.scrollTo = function (this: Element, options?: ScrollToOptions | number) {
      scrolls.push(options)
      instantScrollTo.call(this, options as ScrollToOptions)
    } as typeof Element.prototype.scrollTo
    const matchMedia = vi
      .spyOn(window, 'matchMedia')
      .mockImplementation((query) => ({ matches: query.includes('reduce') }) as MediaQueryList)
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Open shot 1' }))

    fireEvent.click(screen.getByRole('button', { name: 'Next image' }))

    expect(scrolls).toEqual([{ left: SLIDE_WIDTH, behavior: 'auto' }])
    matchMedia.mockRestore()
  })

  it('shows one image with download and no counter or navigation', () => {
    render(<Harness images={IMAGES.slice(0, 1)} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open shot 1' }))

    expect(screen.getByRole('button', { name: 'Download shot-1.png' })).toBeInTheDocument()
    expect(counter()).toBeNull()
    expect(screen.queryByRole('button', { name: 'Next image' })).toBeNull()
  })

  it('stays closed with no images', () => {
    render(
      <ImageGalleryLightbox
        images={[]}
        openIndex={0}
        opener={null}
        onClose={() => {}}
        onDownload={() => {}}
      />
    )

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  describe('mobile shell', () => {
    let cleanup: () => void

    beforeEach(() => {
      window.history.replaceState(null, '', '#/base')
      cleanup = armMobileOverlayBackStack()
    })

    afterEach(() => cleanup())

    it('closes on system back, consumes the sentinel and returns focus to the opener', async () => {
      render(<Harness />)
      const opener = screen.getByRole('button', { name: 'Open shot 2' })
      fireEvent.click(opener)
      await waitForSentinelDepth(1)

      await pressSystemBack()

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(location.hash).toBe('#/base')
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
      await waitFor(() => expect(document.activeElement).toBe(opener))
    })
  })
})
