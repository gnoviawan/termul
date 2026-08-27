import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IconPicker } from './IconPicker'

// Minimal DOMPurify-backed sanitize works in jsdom (see sanitize-agent-icon.test.ts).
// The IconPicker uses sanitizeInlineAgentSvg internally; we test the upload path
// end-to-end through the hidden file input + FileReader.

const VALID_SVG = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4"/></svg>'
const INVALID_SVG = '<div>not an svg</div>'

describe('IconPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the trigger button', () => {
    render(<IconPicker value="" onChange={() => {}} />)
    expect(screen.getByLabelText('Choose icon')).toBeInTheDocument()
  })

  it('opens the picker dialog and shows the upload affordance', () => {
    render(<IconPicker value="" onChange={() => {}} />)
    fireEvent.click(screen.getByLabelText('Choose icon'))
    expect(screen.getByRole('heading', { name: 'Choose icon' })).toBeInTheDocument()
    expect(screen.getByLabelText('Upload custom SVG icon')).toBeInTheDocument()
  })

  it('accepts a valid uploaded SVG and calls onChange', async () => {
    const onChange = vi.fn()
    render(<IconPicker value="" onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('Choose icon'))
    const input = screen.getByLabelText('Upload custom SVG icon') as HTMLInputElement
    const file = new File([VALID_SVG], 'icon.svg', { type: 'image/svg+xml' })
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
    // The sanitized SVG is passed to onChange.
    expect(onChange.mock.calls[0][0]).toContain('viewBox')
  })

  it('rejects an invalid SVG (no root svg/viewBox) with an inline error', async () => {
    const onChange = vi.fn()
    render(<IconPicker value="" onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('Choose icon'))
    const input = screen.getByLabelText('Upload custom SVG icon') as HTMLInputElement
    const file = new File([INVALID_SVG], 'bad.svg', { type: 'image/svg+xml' })
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('rejects an oversize file (>64KB)', async () => {
    const onChange = vi.fn()
    render(<IconPicker value="" onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('Choose icon'))
    const input = screen.getByLabelText('Upload custom SVG icon') as HTMLInputElement
    // 65KB string — over the 64KB cap.
    const big = 'x'.repeat(65 * 1024)
    const file = new File([big], 'big.svg', { type: 'image/svg+xml' })
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => {
      const alert = screen.getByRole('alert')
      expect(alert.textContent).toContain('too large')
    })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows a custom (non-bundled) SVG in the trigger when value is set', () => {
    render(<IconPicker value={VALID_SVG} onChange={() => {}} />)
    // The trigger button should render (not the Pencil fallback).
    const trigger = screen.getByLabelText('Choose icon')
    expect(trigger).toBeInTheDocument()
    // The trigger contains an inline span with the SVG (sanitized).
    expect(trigger.querySelector('svg')).not.toBeNull()
  })
})
