import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TunnelPanel } from './TunnelPanel'

describe('TunnelPanel', () => {
  it('renders tunnel controls', () => {
    render(<TunnelPanel />)
    expect(screen.getByText(/Cloudflare Tunnel/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Start/i })).toBeInTheDocument()
  })
})
