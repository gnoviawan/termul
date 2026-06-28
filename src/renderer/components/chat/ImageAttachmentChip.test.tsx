import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ImageAttachmentChip } from './ImageAttachmentChip'

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return {
    ...actual,
    useReducedMotion: () => true
  }
})

vi.mock('@/components/ui/image-lightbox', () => ({
  ImageLightbox: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

describe('ImageAttachmentChip', () => {
  it('renders image with accessible alt', () => {
    render(<ImageAttachmentChip src="data:image/png;base64,abc" alt="Screenshot" size="composer" />)
    expect(screen.getByRole('img', { name: 'Screenshot' })).toBeInTheDocument()
  })

  it('shows remove button when onRemove is provided', () => {
    const onRemove = vi.fn()
    render(
      <ImageAttachmentChip
        src="data:image/png;base64,abc"
        alt="Screenshot"
        size="composer"
        onRemove={onRemove}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove Screenshot' }))
    expect(onRemove).toHaveBeenCalledOnce()
  })

  it('omits remove button when onRemove is absent', () => {
    render(<ImageAttachmentChip src="data:image/png;base64,abc" alt="Image" size="message" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders loading placeholder without image', () => {
    const { container } = render(<ImageAttachmentChip loading src="" alt="Image" size="message" />)
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})
