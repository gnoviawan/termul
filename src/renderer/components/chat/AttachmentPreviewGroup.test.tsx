import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AttachmentPreviewGroup } from './AttachmentPreviewGroup'
import type { PendingAttachment } from './chat-attachments'

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

const imageAtt: PendingAttachment = {
  kind: 'image',
  id: 'att-1',
  name: '{13A24D2D-A486-4}.png',
  mimeType: 'image/png',
  previewUrl: 'data:image/png;base64,abc',
  base64: 'abc'
}

const fileAtt: PendingAttachment = {
  kind: 'file-embed',
  id: 'att-2',
  name: 'notes.md',
  mimeType: 'text/markdown',
  text: '# hi',
  size: 4
}

describe('AttachmentPreviewGroup', () => {
  it('renders image attachments as thumbnail chips without raw filename', () => {
    render(<AttachmentPreviewGroup attachments={[imageAtt]} onRemove={() => {}} />)
    expect(screen.getByRole('img', { name: 'Image' })).toBeInTheDocument()
    expect(screen.queryByText(/\{13A24D2D/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Remove Image/ })).toBeInTheDocument()
  })

  it('renders non-image files as attachment cards with filename', () => {
    render(<AttachmentPreviewGroup attachments={[fileAtt]} onRemove={() => {}} />)
    expect(screen.getByText('notes.md')).toBeInTheDocument()
    expect(screen.getByText('Embedded text')).toBeInTheDocument()
  })
})
