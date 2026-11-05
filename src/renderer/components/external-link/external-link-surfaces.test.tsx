import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ElicitationPrompt } from '@/components/chat/ElicitationPrompt'
import { ExternalLinkConfirmHost } from '@/components/external-link/ExternalLinkConfirm'
import { TerminalAssistPanel } from '@/components/terminal/TerminalAssistPanel'
import { WhatsNewModal } from '@/components/WhatsNewModal'
import { type ExternalOpenSpy, spyOnExternalOpens } from '@/lib/test-utils/external-link-opens'

// The remaining surfaces that hand a URL to the system browser: links in the
// terminal AI assist panel and in release notes (sanitized HTML), the "View on
// GitHub" button, and the "Open link" button of an MCP URL elicitation (the
// URL comes from an MCP server, so it is untrusted). All go through the same
// confirm as chat links.

const { openUrlWithSystemBrowser, respondElicitation } = vi.hoisted(() => ({
  openUrlWithSystemBrowser: vi.fn(() => Promise.resolve({ success: true, data: undefined })),
  respondElicitation: vi.fn(async () => {})
}))

vi.mock('@/lib/api', () => ({ openerApi: { openUrlWithSystemBrowser } }))
vi.mock('@/lib/tauri-opener-api', () => ({ openerApi: { openUrlWithSystemBrowser } }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: () => Promise.resolve() }))
vi.mock('@/hooks/use-mobile-web-shell', () => ({ useMobileWebShell: () => false }))
vi.mock('@/stores/acp-store', () => ({
  useAcpStore: (selector: (s: { respondElicitation: typeof respondElicitation }) => unknown) =>
    selector({ respondElicitation })
}))

const URL_ = 'https://example.com/docs'
const MCP_URL = 'https://mcp.example.com/consent?state=abc'
const RELEASE_URL = 'https://github.com/gnoviawan/termul/releases/tag/v0.4.60'

let spy: ExternalOpenSpy
beforeEach(() => {
  openUrlWithSystemBrowser.mockClear()
  spy = spyOnExternalOpens(openUrlWithSystemBrowser)
})
afterEach(() => spy.restore())

async function flush(): Promise<void> {
  await act(async () => {})
}

async function click(element: Element, init?: MouseEventInit): Promise<void> {
  fireEvent.click(element, init)
  await flush()
}

function renderWithHost(node: ReactNode): void {
  render(
    <>
      {node}
      <ExternalLinkConfirmHost />
    </>
  )
}

const SURFACES: [string, () => HTMLElement, string][] = [
  [
    'terminal assist panel link',
    () => {
      renderWithHost(
        <TerminalAssistPanel
          state={{ kind: 'explain', status: 'done', text: `See [the docs](${URL_}).` }}
          onClose={() => {}}
          onInsertCommand={() => {}}
        />
      )
      return screen.getByText('the docs')
    },
    URL_
  ],
  [
    "What's New release-note link",
    () => {
      renderWithHost(
        <WhatsNewModal
          isOpen
          version="0.4.60"
          notes={`- Fixed links, see [the docs](${URL_})`}
          htmlUrl={RELEASE_URL}
          onClose={() => {}}
        />
      )
      return screen.getByText('the docs')
    },
    URL_
  ],
  [
    "What's New 'View on GitHub' button",
    () => {
      renderWithHost(
        <WhatsNewModal
          isOpen
          version="0.4.60"
          notes={null}
          htmlUrl={RELEASE_URL}
          onClose={() => {}}
        />
      )
      return screen.getByRole('button', { name: /view on github/i })
    },
    RELEASE_URL
  ],
  [
    "MCP elicitation 'Open link' button",
    () => {
      renderWithHost(
        <ElicitationPrompt
          request={{
            requestId: 'el-1',
            agentId: 'agent-1',
            sessionId: 's1',
            mode: 'url',
            url: MCP_URL,
            message: 'Sign in to continue',
            fields: []
          }}
        />
      )
      return screen.getByRole('button', { name: 'Open link' })
    },
    MCP_URL
  ]
]

describe.each(SURFACES)('%s', (_name, mount, url) => {
  it('asks first and opens nothing on click, ctrl/shift click or middle click', async () => {
    const target = mount()
    await click(target, { ctrlKey: true })
    await click(target, { shiftKey: true })
    fireEvent(target, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))
    await flush()
    expect(spy.opens()).toEqual([])

    await click(target)
    expect(spy.opens()).toEqual([])
    expect(screen.getByRole('alertdialog')).toHaveTextContent(url)
  })

  it('opens nothing on Cancel or Escape, and gives focus back', async () => {
    const target = mount()
    target.focus()
    await click(target)
    await click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(document.activeElement).toBe(target))

    await click(target)
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    await flush()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(spy.opens()).toEqual([])
  })

  it('opens exactly once on Open, even when Open is double-clicked', async () => {
    const target = mount()
    fireEvent.click(target, { detail: 1 })
    fireEvent.click(target, { detail: 2 })
    await flush()
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1)

    const open = within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Open' })
    fireEvent.click(open)
    fireEvent.click(open)
    await flush()
    expect(spy.opens()).toEqual([url])
  })
})

describe('Escape on the link dialog', () => {
  it("closes only the link dialog, not the What's New modal under it", async () => {
    const onClose = vi.fn()
    renderWithHost(
      <WhatsNewModal
        isOpen
        version="0.4.60"
        notes={`see [the docs](${URL_})`}
        htmlUrl={null}
        onClose={onClose}
      />
    )
    await click(screen.getByText('the docs'))
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    await flush()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes only the link dialog, not the terminal assist panel under it', async () => {
    const onClose = vi.fn()
    renderWithHost(
      <TerminalAssistPanel
        state={{ kind: 'explain', status: 'done', text: `See [the docs](${URL_}).` }}
        onClose={onClose}
        onInsertCommand={() => {}}
      />
    )
    await click(screen.getByText('the docs'))
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    await flush()
    expect(onClose).not.toHaveBeenCalled()
  })
})
