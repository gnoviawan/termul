import { render, screen } from '@testing-library/react'
import { createContext, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

vi.mock('streamdown', () => {
  const StreamdownContext = createContext({ controls: false, isAnimating: false })
  return {
    StreamdownContext,
    TableCopyDropdown: ({ children }: { children: ReactNode }) => <>{children}</>,
    TableDownloadDropdown: ({ children }: { children: ReactNode }) => <>{children}</>
  }
})

// Same context instance the component consumes (mocked module export).
import { StreamdownContext } from 'streamdown'
import { ChatMarkdownTable } from './chat-markdown-table'

const CONTROLS_ENABLED = {
  controls: { table: { copy: true, download: true, fullscreen: true } },
  isAnimating: false
}

function withControlsEnabled(ui: ReactNode): React.JSX.Element {
  return (
    <TooltipProvider>
      <StreamdownContext.Provider value={CONTROLS_ENABLED}>{ui}</StreamdownContext.Provider>
    </TooltipProvider>
  )
}

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

  it('uses the compact my-1 margin on the wrapper (not my-2)', () => {
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
    expect(wrapper).toHaveClass('my-1')
    expect(wrapper).not.toHaveClass('my-2')
  })

  it('renders compact (size-6) toolbar buttons when controls are enabled', () => {
    const { container, getAllByRole } = render(
      withControlsEnabled(
        <ChatMarkdownTable>
          <tbody>
            <tr>
              <td>cell</td>
            </tr>
          </tbody>
        </ChatMarkdownTable>
      )
    )

    // Toolbar IconActionButtons use the sm variant → size-6, never size-11.
    for (const button of getAllByRole('button')) {
      expect(button).toHaveClass('size-6')
      expect(button).not.toHaveClass('size-11')
    }

    // The toolbar's IconActionGroup carries dense (px-1 py-0.5), not the
    // default px-1.5 py-1, so the chrome matches the compact button size.
    const toolbar = container.querySelector('[data-streamdown="table-toolbar"]')
    const group = toolbar?.firstElementChild
    expect(group).toHaveClass('px-1', 'py-0.5')
    expect(group).not.toHaveClass('px-1.5', 'py-1')
  })

  it('IconActionGroup dense variant applies compact padding', async () => {
    const { IconActionGroup } = await import('@/components/ui/icon-action-button')
    const { container } = render(
      <TooltipProvider>
        <IconActionGroup dense>
          <span>child</span>
        </IconActionGroup>
      </TooltipProvider>
    )
    const group = container.firstElementChild
    expect(group).toHaveClass('px-1', 'py-0.5')
    expect(group).not.toHaveClass('px-1.5', 'py-1')
  })
})
