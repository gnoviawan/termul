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
import {
  ExternalLinkConfirmHost,
  handleExternalLinkClick
} from '@/components/external-link/ExternalLinkConfirm'
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

describe('focus after the link re-rendered or remounted while the dialog was open', () => {
  const streamed = (more: string) => `Visit [docs](${URL_}).${more}`

  /** The focused element is a live link to `href` with this text, not `<body>`. */
  function expectFocusOnLink(href: string, text: string): void {
    const active = document.activeElement
    expect(active).not.toBe(document.body)
    expect(active?.isConnected).toBe(true)
    expect(active?.tagName).toBe('A')
    expect(active?.getAttribute('href')).toBe(href)
    expect(active?.textContent).toBe(text)
  }

  async function pause(ms: number): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms))
    })
  }

  it('focuses the same link after more streamed text, then Cancel', async () => {
    const view = renderWithHost(withTooltips(<AgentProse text={streamed('')} streaming reduced />))
    const link = screen.getByText('docs').closest('a') as HTMLElement
    link.focus()
    await click(link)
    view.rerender(withTooltips(<AgentProse text={streamed(' And more')} streaming reduced />))
    await pause(120)

    await click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expectFocusOnLink(URL_, 'docs'))
  })

  it('focuses the remounted copy of the link after Cancel', async () => {
    const view = renderWithHost(
      withTooltips(
        <AgentProse key="a" linkScope="m1" text={streamed('')} streaming={false} reduced />
      )
    )
    const original = screen.getByText('docs').closest('a') as HTMLElement
    original.focus()
    await click(original)
    view.rerender(
      withTooltips(
        <AgentProse key="b" linkScope="m1" text={streamed('')} streaming={false} reduced />
      )
    )
    await flush()
    expect(original.isConnected).toBe(false)

    await click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expectFocusOnLink(URL_, 'docs'))
    expect(document.activeElement).not.toBe(original)
  })

  it('focuses the remounted copy after Escape and after Open, too', async () => {
    for (const answer of ['escape', 'open'] as const) {
      const view = renderWithHost(
        withTooltips(
          <AgentProse key="a" linkScope="m1" text={streamed('')} streaming={false} reduced />
        )
      )
      const original = screen.getByText('docs').closest('a') as HTMLElement
      original.focus()
      await click(original)
      view.rerender(
        withTooltips(
          <AgentProse key="b" linkScope="m1" text={streamed('')} streaming={false} reduced />
        )
      )
      await flush()
      if (answer === 'escape') {
        fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
        await flush()
      } else {
        await click(screen.getByRole('button', { name: 'Open' }))
      }
      await waitFor(() => expectFocusOnLink(URL_, 'docs'))
      view.unmount()
    }
  })

  it('picks the same one of two links to the same URL', async () => {
    const text = `[one](${URL_}) and [two](${URL_})`
    const view = renderWithHost(
      withTooltips(<AgentProse key="a" linkScope="m1" text={text} streaming={false} reduced />)
    )
    const second = screen.getByText('two').closest('a') as HTMLElement
    second.focus()
    await click(second)
    view.rerender(
      withTooltips(<AgentProse key="b" linkScope="m1" text={text} streaming={false} reduced />)
    )
    await flush()

    await click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expectFocusOnLink(URL_, 'two'))
  })

  it('finds the remounted message by its scope key, not another message with the same URL', async () => {
    const two = (key: string) =>
      withTooltips(
        <>
          <AgentProse
            key="other"
            linkScope="m0"
            text={`[other](${URL_})`}
            streaming={false}
            reduced
          />
          <AgentProse key={key} linkScope="m1" text={`[mine](${URL_})`} streaming={false} reduced />
        </>
      )
    const view = renderWithHost(two('a'))
    const mine = screen.getByText('mine').closest('a') as HTMLElement
    mine.focus()
    await click(mine)
    view.rerender(two('b'))
    await flush()

    await click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expectFocusOnLink(URL_, 'mine'))
  })

  it('does not move focus into another message that links to the same URL', async () => {
    const pane = (rows: ReactNode) => withTooltips(<section aria-label="chat pane">{rows}</section>)
    const other = (
      <div key="other" data-testid="other-row">
        <AgentProse text={`[other](${URL_})`} streaming={false} reduced />
      </div>
    )
    const view = renderWithHost(
      pane([
        other,
        <div key="mine">
          <AgentProse text={`[mine](${URL_})`} streaming={false} reduced />
        </div>
      ])
    )
    const mine = screen.getByText('mine').closest('a') as HTMLElement
    mine.focus()
    await click(mine)
    // The clicked row leaves the (virtualized) list while the dialog is open.
    view.rerender(pane([other]))
    await flush()

    await click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(document.activeElement).not.toBe(document.body))
    expect(screen.getByTestId('other-row').contains(document.activeElement)).toBe(false)
    expect(screen.getByRole('region', { name: 'chat pane' }).contains(document.activeElement)).toBe(
      true
    )
  })

  it('focuses the nearest surviving container when the link is gone for good', async () => {
    const pane = (body: ReactNode) =>
      withTooltips(
        <section aria-label="chat pane">
          <div>{body}</div>
        </section>
      )
    const view = renderWithHost(pane(<AgentProse text={streamed('')} streaming={false} reduced />))
    const link = screen.getByText('docs').closest('a') as HTMLElement
    link.focus()
    await click(link)
    view.rerender(pane(<p>The message was removed.</p>))
    await flush()

    await click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(document.activeElement).not.toBe(document.body))
    const pane_ = screen.getByRole('region', { name: 'chat pane' })
    expect(pane_.contains(document.activeElement)).toBe(true)
  })
})

describe('fragment links in a thinking block', () => {
  const scrolled: Element[] = []
  const original = Element.prototype.scrollIntoView
  beforeEach(() => {
    scrolled.length = 0
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this)
    }
  })
  afterEach(() => {
    Element.prototype.scrollIntoView = original
  })

  async function renderThought(text: string): Promise<void> {
    renderWithHost(<ThoughtGroup messages={[thought(text)]} isLiveTail={false} />)
    await click(screen.getByRole('button', { expanded: false }))
  }

  it('scrolls within the thought and asks nothing', async () => {
    await renderThought('Read the note[^1].\n\n[^1]: The footnote body.\n')
    await click(screen.getByText('1'))

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(browserOpens()).toEqual([])
    expect(scrolled.map((el) => el.id)).toEqual(['user-content-fn-1'])
  })

  it('does nothing for a fragment with no target, and opens nothing', async () => {
    await renderThought('See [jump](#nowhere).')
    await click(screen.getByText('jump'))

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(browserOpens()).toEqual([])
    expect(scrolled).toEqual([])
  })
})

describe('fragment links in delegated HTML containers', () => {
  const scrolled: Element[] = []
  const original = Element.prototype.scrollIntoView
  beforeEach(() => {
    scrolled.length = 0
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this)
    }
  })
  afterEach(() => {
    Element.prototype.scrollIntoView = original
  })

  it('scrolls to the target inside the container and asks nothing', async () => {
    renderWithHost(
      <>
        <h2 id="setup">Elsewhere</h2>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: delegated link clicks, as in the app */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: links inside handle the keyboard */}
        <div
          data-external-link-scope=""
          onClick={handleExternalLinkClick}
          onAuxClick={handleExternalLinkClick}
        >
          <a href="#setup">jump</a>
          <h2 id="setup">Setup</h2>
        </div>
      </>
    )
    await click(screen.getByText('jump'))

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(browserOpens()).toEqual([])
    expect(scrolled.map((el) => el.textContent)).toEqual(['Setup'])
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
