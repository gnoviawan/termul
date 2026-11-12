import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ConnectBanner } from './ConnectBanner'

describe('ConnectBanner on the phone', () => {
  it('asks for a tap when the connection started with a tap, and offers Cancel', () => {
    render(<ConnectBanner from="Check" port="true" tap phone onCancel={() => {}} />)
    expect(screen.getByRole('status')).toHaveTextContent('Tap a node to connect')
    expect(screen.getByRole('status')).toHaveTextContent('from Check · true')
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('asks for a drop when the connection is being dragged', () => {
    render(<ConnectBanner from="Check" port="true" tap={false} phone onCancel={() => {}} />)
    expect(screen.getByRole('status')).toHaveTextContent('Drop on a node to connect')
    expect(screen.getByRole('status')).not.toHaveTextContent('Tap')
  })
})
