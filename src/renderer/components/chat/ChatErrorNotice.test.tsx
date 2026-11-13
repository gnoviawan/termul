import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatErrorNotice } from './ChatErrorNotice'

describe('ChatErrorNotice', () => {
  it('gh-821: shows the JSON-RPC code and pretty-printed data under Details', () => {
    render(
      <ChatErrorNotice
        message="Internal error"
        code={-32603}
        data={{ reason: 'login', retryAfter: 30 }}
        onDismiss={vi.fn()}
      />
    )
    const code = screen.getByText('Code -32603')
    expect(code).not.toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Details' }))

    expect(code).toBeVisible()
    expect(screen.getByTestId('chat-error-data').textContent).toBe(
      '{\n  "reason": "login",\n  "retryAfter": 30\n}'
    )
  })

  it('gh-821: shows a code without data', () => {
    render(<ChatErrorNotice message="Internal error" code={-32000} onDismiss={vi.fn()} />)
    expect(screen.getByText('Code -32000')).toBeInTheDocument()
    expect(screen.queryByTestId('chat-error-data')).not.toBeInTheDocument()
  })

  it('has no Details for a plain error', () => {
    render(<ChatErrorNotice message="boom" onDismiss={vi.fn()} />)
    expect(screen.getByText('boom')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Details' })).not.toBeInTheDocument()
  })
})
