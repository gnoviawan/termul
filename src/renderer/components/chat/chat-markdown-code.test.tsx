import { render } from '@testing-library/react'
import { createContext } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

vi.mock('streamdown', () => {
  const StreamdownContext = createContext({ lineNumbers: false, isAnimating: false })
  return {
    StreamdownContext,
    Streamdown: () => null,
    // Capture source and presentation props without reproducing Streamdown internals.
    CodeBlock: (props: { code?: string; className?: string; children?: React.ReactNode }) => (
      <div
        data-testid="code-block"
        data-code={props.code ?? ''}
        data-class-name={props.className ?? ''}
      >
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
  it('preserves and visually separates multi-line fenced code via the node value', () => {
    const node = { value: 'line1\nline2\nline3' }
    const { getByTestId } = render(
      withTooltip(
        <ChatMarkdownCode className="language-ts" data-block node={node}>
          {['line1', 'line2', 'line3']}
        </ChatMarkdownCode>
      )
    )

    const codeBlock = getByTestId('code-block')
    expect(codeBlock.getAttribute('data-code')).toBe('line1\nline2\nline3')
    expect(codeBlock.getAttribute('data-class-name')).toContain('[&_code>span]:block')
  })

  it('preserves a blank line and forwards the direct-line layout selector', () => {
    const node = { value: 'line1\n\nline3' }
    const { getByTestId } = render(
      withTooltip(
        <ChatMarkdownCode className="language-ts" data-block node={node}>
          {['line1', '', 'line3']}
        </ChatMarkdownCode>
      )
    )

    const codeBlock = getByTestId('code-block')
    expect(codeBlock.getAttribute('data-code')).toBe('line1\n\nline3')
    expect(codeBlock.getAttribute('data-class-name')).toContain('[&_code>span]:block')
  })

  it('recurses through array children preserving embedded newlines (no node value)', () => {
    const { getByTestId } = render(
      withTooltip(
        <ChatMarkdownCode className="language-ts" data-block>
          {['line1\n', 'line2\n', 'line3']}
        </ChatMarkdownCode>
      )
    )

    expect(getByTestId('code-block').getAttribute('data-code')).toBe('line1\nline2\nline3')
  })

  it('renders inline code with the inline-code data attribute', () => {
    const { container } = render(withTooltip(<ChatMarkdownCode>inline snippet</ChatMarkdownCode>))

    const code = container.querySelector('code')
    expect(code).toHaveAttribute('data-streamdown', 'inline-code')
    expect(code).not.toHaveClass('[&_code>span]:block')
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
