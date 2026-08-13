import { render } from '@testing-library/react'
import { createContext } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

const { useIsCodeFenceIncompleteMock } = vi.hoisted(() => ({
  useIsCodeFenceIncompleteMock: vi.fn(() => false)
}))

vi.mock('streamdown', () => {
  const StreamdownContext = createContext({ lineNumbers: false, isAnimating: false })
  return {
    StreamdownContext,
    Streamdown: () => null,
    useIsCodeFenceIncomplete: useIsCodeFenceIncompleteMock,
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

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn(() => Promise.resolve())
}))

import { ChatMarkdownCode } from './chat-markdown-code'

function withTooltip(ui: React.JSX.Element): React.JSX.Element {
  return <TooltipProvider>{ui}</TooltipProvider>
}

describe('ChatMarkdownCode', () => {
  afterEach(() => {
    useIsCodeFenceIncompleteMock.mockReturnValue(false)
  })

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

  it('renders a termul-plan fence as a PlanPanel, not a code block', () => {
    const plan = [{ content: 'Read the spec', status: 'pending' }]
    const json = JSON.stringify(plan)
    const { getByText, queryByTestId } = render(
      withTooltip(
        <ChatMarkdownCode className="language-termul-plan" data-block node={{ value: json }}>
          {json}
        </ChatMarkdownCode>
      )
    )

    expect(getByText('Read the spec')).toBeInTheDocument()
    expect(queryByTestId('code-block')).toBeNull()
  })

  it('shows a fallback card for a malformed termul-plan fence', () => {
    const { getByText, queryByTestId } = render(
      withTooltip(
        <ChatMarkdownCode className="language-termul-plan" data-block node={{ value: '{bad' }}>
          {'{bad'}
        </ChatMarkdownCode>
      )
    )

    expect(getByText('Plan snapshot unavailable')).toBeInTheDocument()
    expect(queryByTestId('code-block')).toBeNull()
  })

  it('shows a fallback card for an empty plan fence', () => {
    const { getByText, queryByTestId } = render(
      withTooltip(
        <ChatMarkdownCode className="language-termul-plan" data-block node={{ value: '[]' }}>
          {'[]'}
        </ChatMarkdownCode>
      )
    )

    expect(getByText('Plan snapshot unavailable')).toBeInTheDocument()
    expect(queryByTestId('code-block')).toBeNull()
  })

  it('shows a streaming placeholder when the fence is incomplete', () => {
    useIsCodeFenceIncompleteMock.mockReturnValue(true)
    const { getByText, queryByTestId } = render(
      withTooltip(
        <ChatMarkdownCode className="language-termul-plan" data-block node={{ value: 'partial' }}>
          {'partial'}
        </ChatMarkdownCode>
      )
    )

    expect(getByText('Plan snapshot incomplete')).toBeInTheDocument()
    expect(queryByTestId('code-block')).toBeNull()
  })
})
