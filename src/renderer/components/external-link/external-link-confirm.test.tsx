import { BlockNoteViewRaw } from '@blocknote/react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { EditorView } from '@tiptap/pm/view'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentProse } from '@/components/chat/chat-agent-prose'
import { ThoughtGroup } from '@/components/chat/ThoughtGroup'
import { MarkdownEditor } from '@/components/editor/MarkdownEditor'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useBlockNote } from '@/hooks/use-blocknote'
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

// Mirrors tauri-plugin-opener 2.5.4 `init-iife.js`: the desktop app injects a
// window click listener that sends any unprevented left click on an
// `<a target="_blank">` (or a ctrl/shift click on any `<a>`) straight to the OS
// browser. jsdom has no such listener, so a test that only spies on openerApi
// would miss that channel.
const pluginOpens: string[] = []
function openerPluginClick(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey) return
  const a = event
    .composedPath()
    .find((el) => el instanceof Node && el.nodeName.toUpperCase() === 'A') as
    | HTMLAnchorElement
    | undefined
  if (!a?.href || !(a.target === '_blank' || event.ctrlKey || event.shiftKey)) return
  const url = new URL(a.href)
  if (['http:', 'https:', 'mailto:', 'tel:'].every((p) => url.protocol !== p)) return
  event.preventDefault()
  pluginOpens.push(url.href)
}

let windowOpen: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  openUrlWithSystemBrowser.mockClear()
  pluginOpens.length = 0
  window.addEventListener('click', openerPluginClick)
  windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null)
})

afterEach(() => {
  window.removeEventListener('click', openerPluginClick)
  windowOpen.mockRestore()
})

/** Every way a URL can leave the app: openerApi, the opener plugin, window.open. */
function browserOpens(): string[] {
  return [
    ...openUrlWithSystemBrowser.mock.calls.map((call) => String((call as unknown[])[0])),
    ...pluginOpens,
    ...windowOpen.mock.calls.map((call) => String(call[0] ?? ''))
  ]
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
      render(withTooltips(<AgentProse text={`Visit [docs](${URL_}).`} streaming={false} reduced />))
      return screen.getByText('docs')
    }
  ],
  [
    'agent chat reply with a workspace (file links on)',
    async () => {
      render(
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
      render(
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
      render(<ThoughtGroup messages={[thought(`Check [docs](${URL_}).`)]} isLiveTail={false} />)
      await click(screen.getByRole('button', { expanded: false }))
      return screen.getByText('docs')
    }
  ],
  [
    'markdown file in the editor',
    async () => {
      const { container } = render(
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
    const { container } = render(<Harness />)
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
