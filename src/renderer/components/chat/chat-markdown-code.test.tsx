import { render } from '@testing-library/react'
import { createContext } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

vi.mock('streamdown', () => {
  const StreamdownContext = createContext({ lineNumbers: false, isAnimating: false })
  return {
    StreamdownContext,
    Streamdown: () => null,
    // Capture the `code` prop so tests can assert newline preservation.
    CodeBlock: (props: { code?: string; children?: React.ReactNode }) => (
      <div data-testid="code-block" data-code={props.code ?? ''}>
        {props.children}
      </div>
    )
  }
})

vi.mock('@streamdown/mermaid', () => ({ mermaid: () => {} }))

import { ChatMarkdownCode } from './chat-markdown-code'

function withTooltip(ui: React.JSX.Element): React.JSX.Element {
  return <TooltipProvider>{ui}</TooltipProvider>
}

describe('ChatMarkdownCode', () => {
  it('preserves newlines in a multi-line fenced code block via the node value', () => {
    const node = { value: 'line1\nline2\nline3' }
    const { getByTestId } = render(
      withTooltip(
        <ChatMarkdownCode className="language-ts" data-block node={node}>
          {['line1', 'line2', 'line3']}
        </ChatMarkdownCode>
      )
    )

    expect(getByTestId('code-block').getAttribute('data-code')).toBe('line1\nline2\nline3')
  })

  it('joins array children with newline when any segment carries a newline (no node value)', () => {
    const { getByTestId } = render(
      withTooltip(
        <ChatMarkdownCode className="language-ts" data-block>
          {['line1\nline2', 'line3']}
        </ChatMarkdownCode>
      )
    )

    expect(getByTestId('code-block').getAttribute('data-code')).toBe('line1\nline2\nline3')
  })

  it('renders inline code with the inline-code data attribute', () => {
    const { container } = render(withTooltip(<ChatMarkdownCode>inline snippet</ChatMarkdownCode>))

    const code = container.querySelector('code')
    expect(code).toHaveAttribute('data-streamdown', 'inline-code')
  })

  it('passes the compact size class to the copy/download action buttons', () => {
    const { getAllByRole } = render(
      withTooltip(
        <ChatMarkdownCode className="language-ts" data-block>
          {'const x = 1'}
        </ChatMarkdownCode>
      )
    )

    // IconActionButton renders a <button>; the sm variant applies size-6 (not size-11).
    for (const button of getAllByRole('button')) {
      expect(button).toHaveClass('size-6')
      expect(button).not.toHaveClass('size-11')
    }
  })
})
