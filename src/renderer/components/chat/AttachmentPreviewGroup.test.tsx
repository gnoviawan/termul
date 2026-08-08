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

const fileRefText: PendingAttachment = {
  kind: 'file-ref',
  id: 'att-3',
  name: 'app.tsx',
  mimeType: 'text/tsx',
  path: 'D:\\proj\\app.tsx'
}

const fileRefImage: PendingAttachment = {
  kind: 'file-ref',
  id: 'att-4',
  name: 'pic.png',
  mimeType: 'image/png',
  path: 'D:\\proj\\pic.png',
  previewUrl: 'data:image/png;base64,xyz'
}

describe('AttachmentPreviewGroup', () => {
  it('renders image attachments as thumbnail chips without raw filename', () => {
    render(<AttachmentPreviewGroup attachments={[imageAtt]} onRemove={() => {}} />)
    expect(screen.getByRole('img', { name: 'Image' })).toBeInTheDocument()
    expect(screen.queryByText(/\{13A24D2D/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Remove Image/ })).toBeInTheDocument()
  })

  it('renders embedded text files as attachment badges with filename', () => {
    render(<AttachmentPreviewGroup attachments={[fileAtt]} onRemove={() => {}} />)
    expect(screen.getByText('notes.md')).toBeInTheDocument()
  })

  it('renders a text file-ref as a non-clickable badge without opening its path', () => {
    render(<AttachmentPreviewGroup attachments={[fileRefText]} onRemove={() => {}} />)
    expect(screen.getByText('app.tsx')).toBeInTheDocument()
    // No open-path trigger — clicks are disabled to avoid sandbox/path errors.
    expect(screen.queryByRole('button', { name: /Open / })).not.toBeInTheDocument()
  })

  it('previews an image file-ref inline without opening its path', () => {
    render(<AttachmentPreviewGroup attachments={[fileRefImage]} onRemove={() => {}} />)
    // Image refs render a hover-preview badge, not an open-path trigger.
    expect(screen.queryByRole('button', { name: /Open pic\.png/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'pic.png' })).toBeInTheDocument()
  })

  it('does not render an open trigger for inline image attachments', () => {
    render(<AttachmentPreviewGroup attachments={[imageAtt]} onRemove={() => {}} />)
    expect(screen.queryByRole('button', { name: /Open / })).not.toBeInTheDocument()
  })

  it('does not render an open trigger for embedded text attachments', () => {
    render(<AttachmentPreviewGroup attachments={[fileAtt]} onRemove={() => {}} />)
    expect(screen.queryByRole('button', { name: /Open / })).not.toBeInTheDocument()
  })
})
