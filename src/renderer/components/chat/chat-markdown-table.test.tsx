import { render, screen } from '@testing-library/react'
import { createContext } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('streamdown', () => {
  const StreamdownContext = createContext({ controls: false, isAnimating: false })
  return {
    StreamdownContext,
    TableCopyDropdown: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TableDownloadDropdown: ({ children }: { children: React.ReactNode }) => <>{children}</>
  }
})

import { ChatMarkdownTable } from './chat-markdown-table'

describe('ChatMarkdownTable', () => {
  it('rerenders growing streamed children even when the class name is unchanged', () => {
    const { rerender } = render(
      <ChatMarkdownTable className="same-table">
        <tbody>
          <tr>
            <td>row one</td>
          </tr>
        </tbody>
      </ChatMarkdownTable>
    )

    rerender(
      <ChatMarkdownTable className="same-table">
        <tbody>
          <tr>
            <td>row one</td>
          </tr>
          <tr>
            <td>row two</td>
          </tr>
        </tbody>
      </ChatMarkdownTable>
    )

    expect(screen.getByText('row two')).toBeInTheDocument()
  })

  it('keeps one lightweight boundary and a horizontal overflow region', () => {
    const { container } = render(
      <ChatMarkdownTable>
        <tbody>
          <tr>
            <td>cell</td>
          </tr>
        </tbody>
      </ChatMarkdownTable>
    )

    const wrapper = container.querySelector('[data-streamdown="table-wrapper"]')
    expect(wrapper).toHaveClass('overflow-hidden', 'border')
    expect(wrapper?.querySelector('.overflow-x-auto')).toBeInTheDocument()
  })

  it('exposes a keyboard-focusable scroll region for wide tables', () => {
    const { container } = render(
      <ChatMarkdownTable>
        <tbody>
          <tr>
            <td>cell</td>
          </tr>
        </tbody>
      </ChatMarkdownTable>
    )

    const scrollRegion = container.querySelector('.overflow-x-auto')
    expect(scrollRegion?.tagName).toBe('SECTION')
    expect(scrollRegion).toHaveAttribute('tabindex', '0')
    expect(scrollRegion).toHaveAttribute('aria-label', 'Markdown table')
  })
})
