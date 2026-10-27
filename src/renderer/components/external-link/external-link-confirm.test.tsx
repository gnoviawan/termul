import { BlockNoteViewRaw } from '@blocknote/react'
import {
  act,
  fireEvent,
  type RenderResult,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import type { EditorView } from '@tiptap/pm/view'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentProse } from '@/components/chat/chat-agent-prose'
import { ThoughtGroup } from '@/components/chat/ThoughtGroup'
import { MarkdownEditor } from '@/components/editor/MarkdownEditor'
import { ExternalLinkConfirmHost } from '@/components/external-link/ExternalLinkConfirm'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useBlockNote } from '@/hooks/use-blocknote'
import { type ExternalOpenSpy, spyOnExternalOpens } from '@/lib/test-utils/external-link-opens'
import type { ChatMessage } from '@/stores/acp-store'

// QA matrix for issue #1432: a link must not reach the system browser until the
// user answers "Open" in the confirmation dialog, on every surface that renders
// one (agent chat replies, thinking blocks, markdown files in the editor).

const openUrlWithSystemBrowser = vi.fn(() => Promise.resolve({ success: true, data: undefined }))

vi.mock('@/lib/api', () => ({
  openerApi: {
    openUrlWithSystemBrowser: (...args: unknown[]) => openUrlWithSystemBrowser(...args)
  }
}))

vi.mock('@/lib/log-api', () => ({ logFrontendError: () => Promise.resolve() }))

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return { ...actual, useReducedMotion: () => true }
})

const URL_ = 'https://example.com/docs'

let spy: ExternalOpenSpy

beforeEach(() => {
  openUrlWithSystemBrowser.mockClear()
  spy = spyOnExternalOpens(openUrlWithSystemBrowser)
})

afterEach(() => {
  spy.restore()
})

/** Every way a URL can leave the app: openerApi, the opener plugin, window.open. */
function browserOpens(): string[] {
  return spy.opens()
}

/** Render next to the app-wide confirm host, as `App`/`TauriApp` do. */
function renderWithHost(node: ReactNode): RenderResult {
  const result = render(
    <>
      {node}
      <ExternalLinkConfirmHost />
    </>
  )
  return {
    ...result,
    rerender: (next: ReactNode) =>
      result.rerender(
        <>
          {next}
          <ExternalLinkConfirmHost />
        </>
      )
  }
}

async function flush(): Promise<void> {
  await act(async () => {})
}

async function click(element: Element, init?: MouseEventInit): Promise<void> {
  fireEvent.click(element, init)
  await flush()
}

function thought(text: string): ChatMessage {
  return {
    id: 't1',
    role: 'thought',
    blocks: [{ type: 'text', text }],
    streaming: false,
    timestamp: 0
  }
}

function withTooltips(node: ReactNode): ReactNode {
  return <TooltipProvider>{node}</TooltipProvider>
}

const SURFACES: [string, () => Promise<HTMLElement>][] = [
  [
    'agent chat reply',
    async () => {
      renderWithHost(
        withTooltips(<AgentProse text={`Visit [docs](${URL_}).`} streaming={false} reduced />)
      )
      return screen.getByText('docs')
    }
  ],
  [
    'agent chat reply with a workspace (file links on)',
    async () => {
      renderWithHost(
        withTooltips(
          <AgentProse
            text={`Visit [docs](${URL_}).`}
            streaming={false}
            reduced
            filePathContext={{ cwd: '/project' }}
          />
        )
      )
      return screen.getByText('docs')
    }
  ],
  [
    'agent chat bare URL',
    async () => {
      renderWithHost(
        withTooltips(
          <AgentProse
            text={`See ${URL_} now.`}
            streaming={false}
            reduced
            filePathContext={{ cwd: '/project' }}
          />
        )
      )
      return screen.getByText(URL_)
    }
  ],
  [
    'thinking block',
    async () => {
      renderWithHost(
        <ThoughtGroup messages={[thought(`Check [docs](${URL_}).`)]} isLiveTail={false} />
      )
      await click(screen.getByRole('button', { expanded: false }))
      return screen.getByText('docs')
    }
  ],
  [
    'markdown file in the editor',
    async () => {
      const { container } = renderWithHost(
        <MarkdownEditor
          filePath="/project/README.md"
          content={`Read [docs](${URL_}).\n`}
          isVisible
          onChange={() => {}}
        />
      )
      await flush()
      const link = container.querySelector(`a[href="${URL_}"]`)
      if (!(link instanceof HTMLElement)) throw new Error('editor rendered no link')
      return link
    }
  ]
]

describe.each(SURFACES)('external link on %s', (_name, mount) => {
  it('shows the dialog and opens nothing on the first click', async () => {
    const link = await mount()
    await click(link)

    expect(browserOpens()).toEqual([])
    expect(within(screen.getByRole('alertdialog')).getByText(URL_)).toBeInTheDocument()
  })

  it('opens nothing on a ctrl/shift/middle click either', async () => {
    const link = await mount()
    await click(link, { ctrlKey: true })
    await click(link, { shiftKey: true })
    fireEvent(link, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))
    await flush()

    expect(browserOpens()).toEqual([])
  })

  it('opens nothing when the user picks Cancel', async () => {
    const link = await mount()
    await click(link)
    await click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(browserOpens()).toEqual([])
  })

  it('opens nothing when the user presses Escape', async () => {
    const link = await mount()
    await click(link)
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    await flush()

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(browserOpens()).toEqual([])
  })

  it('opens nothing when the user clicks outside the dialog', async () => {
    const link = await mount()
    await click(link)
    const outside = document.body
    fireEvent.pointerDown(outside)
    fireEvent.mouseDown(outside)
    fireEvent.pointerUp(outside)
    fireEvent.mouseUp(outside)
    await click(outside)

    expect(browserOpens()).toEqual([])
  })

  it('opens the system browser exactly once when the user picks Open', async () => {
    const link = await mount()
    await click(link)
    await click(screen.getByRole('button', { name: 'Open' }))

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(browserOpens()).toEqual([URL_])
    expect(openUrlWithSystemBrowser).toHaveBeenCalledTimes(1)
  })

  it('opens once when Open is double-clicked', async () => {
    const link = await mount()
    await click(link)
    const open = screen.getByRole('button', { name: 'Open' })
    fireEvent.click(open, { detail: 1 })
    fireEvent.click(open, { detail: 2 })
    await flush()

    expect(browserOpens()).toEqual([URL_])
  })

  it('shows one dialog and opens one tab on a fast double click of the link', async () => {
    const link = await mount()
    fireEvent.click(link, { detail: 1 })
    fireEvent.click(link, { detail: 2 })
    fireEvent.doubleClick(link)
    await flush()

    expect(screen.getAllByRole('alertdialog')).toHaveLength(1)
    expect(browserOpens()).toEqual([])

    await click(screen.getByRole('button', { name: 'Open' }))
    expect(browserOpens()).toEqual([URL_])
  })
})

describe.each(SURFACES)('focus after the dialog on %s', (_name, mount) => {
  // A real mouse click focuses the link; a keyboard user lands on it with Tab.
  async function openFromFocusedLink(): Promise<HTMLElement> {
    const link = await mount()
    const anchor = link.closest('a') ?? link
    anchor.focus()
    await click(link)
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    return anchor
  }

  it('returns focus to the link after Cancel', async () => {
    const anchor = await openFromFocusedLink()
    await click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(document.activeElement).toBe(anchor))
  })

  it('returns focus to the link after Escape', async () => {
    const anchor = await openFromFocusedLink()
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    await flush()
    await waitFor(() => expect(document.activeElement).toBe(anchor))
  })

  it('returns focus to the link after Open', async () => {
    const anchor = await openFromFocusedLink()
    await click(screen.getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(document.activeElement).toBe(anchor))
  })
})

describe('pending confirmation outlives the message that asked for it', () => {
  const streamed = (more: string) => `Visit [docs](${URL_}).${more}`

  it('keeps the dialog while the agent keeps streaming, and Open still opens once', async () => {
    const view = renderWithHost(withTooltips(<AgentProse text={streamed('')} streaming reduced />))
    await click(screen.getByText('docs'))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    for (const more of [' More', ' More text', ' More text\n\nA new paragraph', ' done.']) {
      view.rerender(withTooltips(<AgentProse text={streamed(more)} streaming reduced />))
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 120))
      })
      expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    }
    view.rerender(withTooltips(<AgentProse text={streamed(' done.')} streaming={false} reduced />))
    await flush()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(browserOpens()).toEqual([])

    await click(screen.getByRole('button', { name: 'Open' }))
    expect(browserOpens()).toEqual([URL_])
  })

  it('keeps the dialog when the message remounts (or scrolls out of a virtual list)', async () => {
    const view = renderWithHost(
      withTooltips(<AgentProse key="a" text={streamed('')} streaming={false} reduced />)
    )
    await click(screen.getByText('docs'))
    view.rerender(
      withTooltips(<AgentProse key="b" text={streamed('')} streaming={false} reduced />)
    )
    await flush()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    view.rerender(withTooltips(null))
    await flush()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    await click(screen.getByRole('button', { name: 'Open' }))
    expect(browserOpens()).toEqual([URL_])
  })
})

describe('a very long URL', () => {
  const LONG_URL = `https://example.com/${'a'.repeat(4000)}`

  it('scrolls inside a capped, word-breaking area so Cancel and Open stay on screen', async () => {
    renderWithHost(
      withTooltips(<AgentProse text={`[long](${LONG_URL})`} streaming={false} reduced />)
    )
    await click(screen.getByText('long'))

    const dialog = screen.getByRole('alertdialog')
    const urlText = within(dialog).getByText(LONG_URL)
    const scroller = urlText.closest('[data-external-link-url]')
    expect(scroller).not.toBeNull()
    expect(scroller).toHaveClass('overflow-y-auto', 'break-all')
    expect(scroller?.className).toMatch(/\bmax-h-/)
    // The buttons are outside the scrolling area, so they never scroll away.
    for (const name of ['Cancel', 'Open']) {
      expect(scroller?.contains(within(dialog).getByRole('button', { name }))).toBe(false)
    }
    // The dialog itself is capped to the viewport, too.
    expect(dialog.className).toMatch(/max-h-/)
  })
})

describe('markdown editor link click (ProseMirror handleClick)', () => {
  // jsdom has no layout, so ProseMirror never maps a real mouseup to a
  // document position and tiptap Link's `handleClick` (which calls
  // `window.open` under BlockNote's default `openOnClick`) cannot fire from a
  // synthetic press. Drive the prop the way ProseMirror does instead.
  it('never lets the Link mark open the URL itself', async () => {
    const onLinkClick = vi.fn()
    let view: EditorView | undefined
    function Harness(): React.JSX.Element {
      const { editor } = useBlockNote({
        filePath: '/project/README.md',
        initialMarkdown: `Read [docs](${URL_}).\n`,
        onChange: () => {},
        onLinkClick
      })
      view = editor.prosemirrorView
      return <BlockNoteViewRaw editor={editor} />
    }
    const { container } = renderWithHost(<Harness />)
    await flush()
    const anchor = container.querySelector(`a[href="${URL_}"]`)
    if (!anchor || !view) throw new Error('editor rendered no link')
    const pmView = view

    const event = new MouseEvent('click', { button: 0, bubbles: true, cancelable: true })
    Object.defineProperty(event, 'target', { value: anchor })
    const pos = pmView.posAtDOM(anchor, 0)
    const handled = pmView.someProp('handleClick', (handle) => handle(pmView, pos, event))

    expect(handled).toBe(true)
    expect(browserOpens()).toEqual([])
  })
})
