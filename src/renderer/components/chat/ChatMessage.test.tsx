import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage as ChatMessageType } from '@/stores/acp-store'
import { ChatMessage } from './ChatMessage'

const openUrlWithSystemBrowser = vi.fn(() => Promise.resolve({ success: true, data: undefined }))

vi.mock('@/lib/api', () => ({
  openerApi: {
    openUrlWithSystemBrowser: (...args: unknown[]) => openUrlWithSystemBrowser(...args)
  }
}))

vi.mock('streamdown', async () => {
  const React = await import('react')
  type LinkSafety = {
    enabled: boolean
    onLinkCheck?: (url: string) => boolean | Promise<boolean>
    renderModal?: (props: {
      isOpen: boolean
      onClose: () => void
      onConfirm: () => void
      url: string
    }) => ReactNode
  }

  function MockStreamdown({
    children,
    isAnimating,
    caret,
    linkSafety
  }: {
    children: ReactNode
    isAnimating?: boolean
    caret?: string
    linkSafety?: LinkSafety
  }): React.JSX.Element {
    const [open, setOpen] = React.useState(false)
    const url = 'https://example.com/docs'

    return (
      <div data-testid="streamdown" data-animating={isAnimating} data-caret={caret}>
        <button
          type="button"
          data-testid="streamdown-link"
          onClick={async () => {
            if (!linkSafety?.enabled) return
            const ok = linkSafety.onLinkCheck ? await linkSafety.onLinkCheck(url) : false
            if (ok) return
            setOpen(true)
          }}
        >
          docs
        </button>
        {children}
        {linkSafety?.renderModal?.({
          isOpen: open,
          url,
          onClose: () => setOpen(false),
          onConfirm: () => undefined
        })}
      </div>
    )
  }

  return { Streamdown: MockStreamdown }
})

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return {
    ...actual,
    useReducedMotion: () => true
  }
})

function agentMessage(streaming: boolean): ChatMessageType {
  return {
    id: 'agent-1',
    role: 'agent',
    blocks: [{ type: 'text', text: 'Working on it' }],
    streaming,
    timestamp: 0
  }
}

describe('ChatMessage', () => {
  beforeEach(() => {
    openUrlWithSystemBrowser.mockClear()
  })

  it('shows the Streamdown caret while the live agent message is streaming', () => {
    render(<ChatMessage message={agentMessage(true)} isLast />)

    expect(screen.getByTestId('streamdown')).toHaveAttribute('data-animating', 'true')
    expect(screen.getByTestId('streamdown')).toHaveAttribute('data-caret', 'block')
  })

  it('stops the Streamdown caret when the live agent message finishes', () => {
    render(<ChatMessage message={agentMessage(false)} isLast />)

    expect(screen.getByTestId('streamdown')).toHaveAttribute('data-animating', 'false')
  })

  it('stops the Streamdown caret when a newer timeline item follows', () => {
    render(<ChatMessage message={agentMessage(true)} isLast={false} />)

    expect(screen.getByTestId('streamdown')).toHaveAttribute('data-animating', 'false')
  })

  it('shows the fallback caret when a live empty terminated fence is stripped', () => {
    const message: ChatMessageType = {
      ...agentMessage(true),
      blocks: [{ type: 'text', text: '```bash\n```' }]
    }

    const { container } = render(<ChatMessage message={message} isLast />)

    expect(screen.queryByTestId('streamdown')).not.toBeInTheDocument()
    expect(container.querySelector('.animate-caret-blink')).toBeInTheDocument()
  })

  it('opens confirmed links via the system browser and closes the safety dialog', async () => {
    render(<ChatMessage message={agentMessage(false)} isLast />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('streamdown-link'))
    })
    expect(openUrlWithSystemBrowser).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(openUrlWithSystemBrowser).toHaveBeenCalledWith('https://example.com/docs')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })
})
