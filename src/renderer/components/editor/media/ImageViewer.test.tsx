import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { readMediaBytesMock } = vi.hoisted(() => ({ readMediaBytesMock: vi.fn() }))

vi.mock('@/lib/media-bytes-api', () => ({
  readMediaBytes: (path: string) => readMediaBytesMock(path)
}))

import { ImageViewer } from './ImageViewer'

const urlApi = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown }

beforeEach(() => {
  let next = 0
  urlApi.createObjectURL = () => `blob:termul/${++next}`
  urlApi.revokeObjectURL = () => {}
  readMediaBytesMock.mockReset()
  readMediaBytesMock.mockResolvedValue({ success: true, data: new Blob(['x'.repeat(2048)]) })
})

afterEach(() => {
  cleanup()
  delete urlApi.createObjectURL
  delete urlApi.revokeObjectURL
})

/** jsdom has no layout or decoder: give the image its natural and shown size, then load it. */
async function loadImage(shownWidth: number): Promise<HTMLImageElement> {
  const image = (await screen.findByRole('img', { name: 'shot.png' })) as HTMLImageElement
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 640 })
  Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 480 })
  Object.defineProperty(image, 'clientWidth', { configurable: true, value: shownWidth })
  fireEvent.load(image)
  return image
}

describe('ImageViewer', () => {
  it('fits the image to the pane and shows its dimensions and size', async () => {
    render(<ImageViewer filePath="/project/out/shot.png" revision={0} />)
    const image = await loadImage(320)

    expect(image).toHaveAttribute('src', 'blob:termul/1')
    expect(image.style.width).toBe('')
    expect(screen.getByTestId('viewer-facts')).toHaveTextContent('640 × 480 · 2.0 KB')
    expect(readMediaBytesMock).toHaveBeenCalledWith('/project/out/shot.png')
  })

  it('shows actual size at 1:1, zooms in from there, and returns to fit', async () => {
    render(<ImageViewer filePath="/project/out/shot.png" revision={0} />)
    const image = await loadImage(320)

    fireEvent.click(screen.getByRole('button', { name: '1:1' }))
    expect(image.style.width).toBe('640px')
    expect(screen.getByTestId('viewer-facts')).toHaveTextContent('640 × 480 · 2.0 KB · 100%')

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(image.style.width).toBe('800px')
    expect(screen.getByTestId('viewer-facts')).toHaveTextContent('125%')

    fireEvent.click(screen.getByRole('button', { name: 'Fit' }))
    expect(image.style.width).toBe('')
    expect(screen.getByTestId('viewer-facts')).toHaveTextContent('640 × 480 · 2.0 KB')
  })

  it('zooms out from the scale the fit layout chose', async () => {
    render(<ImageViewer filePath="/project/out/shot.png" revision={0} />)
    const image = await loadImage(320)

    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))

    expect(image.style.width).toBe('256px')
    expect(screen.getByTestId('viewer-facts')).toHaveTextContent('40%')
  })

  it('keeps the old image on screen until a new revision has loaded', async () => {
    let finish: (value: unknown) => void = () => {}
    const { rerender } = render(<ImageViewer filePath="/project/out/shot.png" revision={0} />)
    await loadImage(320)
    readMediaBytesMock.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )

    rerender(<ImageViewer filePath="/project/out/shot.png" revision={1} />)
    expect(screen.getByRole('img', { name: 'shot.png' })).toHaveAttribute('src', 'blob:termul/1')

    await act(async () => finish({ success: true, data: new Blob(['new']) }))
    expect(screen.getByRole('img', { name: 'shot.png' })).toHaveAttribute('src', 'blob:termul/2')
    expect(readMediaBytesMock).toHaveBeenCalledTimes(2)
  })

  it('shows the too-large state with the cap when the read is refused', async () => {
    readMediaBytesMock.mockResolvedValue({
      success: false,
      error: 'file too large (30000000 bytes, max 26214400)',
      code: 'FILE_TOO_LARGE'
    })

    render(<ImageViewer filePath="/project/out/huge.png" revision={0} />)

    expect(await screen.findByText('This file is too large to preview')).toBeInTheDocument()
    expect(screen.getByText('28.6 MB, the preview limit is 25.0 MB')).toBeInTheDocument()
  })
})
