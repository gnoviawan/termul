/**
 * Story 5.1 — pane-scoped responsive layout tests.
 *
 * Test seam: `data-composer-toolbar="narrow|wide"` is driven by
 * `useComposerToolbarMode` (ResizeObserver on the composer root). jsdom does
 * not layout CSS `@container` queries, so we mock element width via
 * `getBoundingClientRect` + ResizeObserver callbacks instead of asserting
 * `@[400px]:` class application visually.
 */

import { act, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { SessionConfigOption } from '@/lib/acp-api'
import type { AcpSession } from '@/stores/acp-store'
import { ChatErrorNotice } from './ChatErrorNotice'
import { ChatInputBar } from './ChatInputBar'
import { ChatMessageList } from './ChatMessageList'
import { CHAT_GUTTER_X, NARROW_PANE_PX } from './chat-layout'
import type { TimelineItem } from './chat-timeline'
import { PlanPanel } from './PlanPanel'

const { mockMcpCount } = vi.hoisted(() => ({
  mockMcpCount: { current: 2 }
}))

vi.mock('@/hooks/use-agent-skills', () => ({
  useAgentSkills: () => ({ skills: [] }),
  buildPromptWithLoadedSkills: vi.fn((_skills: unknown, text: string) => text)
}))

vi.mock('@/stores/acp-store', () => ({
  useAcpStore: (selector: (s: { mcpServers: unknown[] }) => unknown) =>
    selector({ mcpServers: Array.from({ length: mockMcpCount.current }) }),
  useAcpMessages: () => [],
  useSessionUsage: () => null,
  useAgentIdentity: () => ({ name: 'Cursor', templateId: 'cursor' })
}))

type ObserverEntry = { target: Element; contentRect: { width: number } }
type ObserverCallback = (entries: ObserverEntry[]) => void

let observedElements: Array<{ el: Element; cb: ObserverCallback }> = []
let mockWidth = 800

let originalGetBoundingClientRect: PropertyDescriptor | undefined
let originalResizeObserver: typeof ResizeObserver | undefined

function installResizeMocks(width: number): void {
  mockWidth = width
  observedElements = []

  if (originalGetBoundingClientRect === undefined) {
    originalGetBoundingClientRect = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'getBoundingClientRect'
    )
  }
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: 0,
        right: mockWidth,
        width: mockWidth,
        height: 100,
        toJSON() {
          return {}
        }
      }
    }
  })

  if (originalResizeObserver === undefined) {
    originalResizeObserver = global.ResizeObserver
  }
  global.ResizeObserver = class MockResizeObserver {
    private cb: ObserverCallback
    constructor(cb: ObserverCallback) {
      this.cb = cb
    }
    observe(el: Element): void {
      observedElements.push({ el, cb: this.cb })
      this.cb([{ target: el, contentRect: { width: mockWidth } }])
    }
    unobserve(el: Element): void {
      observedElements = observedElements.filter((entry) => entry.el !== el)
    }
    disconnect(): void {
      observedElements = []
    }
  } as unknown as typeof ResizeObserver
}

function restoreResizeMocks(): void {
  if (originalGetBoundingClientRect !== undefined) {
    Object.defineProperty(
      HTMLElement.prototype,
      'getBoundingClientRect',
      originalGetBoundingClientRect
    )
  }
  if (originalResizeObserver !== undefined) {
    global.ResizeObserver = originalResizeObserver
  }
  observedElements = []
}

function setMockWidth(width: number): void {
  mockWidth = width
  act(() => {
    for (const { el, cb } of observedElements) {
      cb([{ target: el, contentRect: { width } }])
    }
  })
}

function option(
  id: string,
  name: string,
  category: string,
  currentValue: string,
  options: Array<{ value: string; name: string }>
): SessionConfigOption {
  return {
    id,
    name,
    category,
    type: 'select',
    currentValue,
    options
  }
}

function session(): AcpSession {
  return {
    id: 'session-1',
    agentId: 'agent-1',
    cwd: '/work',
    projectId: 'p1',
    status: 'active',
    title: null,
    activeTurn: false,
    openTurnId: null,
    modes: {
      currentModeId: 'agent',
      availableModes: [
        { id: 'agent', name: 'Agent' },
        { id: 'plan', name: 'Plan' },
        { id: 'ask', name: 'Ask' }
      ]
    },
    models: null,
    configOptions: [],
    lastError: null,
    createdAt: 1
  }
}

const timelineItem: TimelineItem = {
  kind: 'message',
  key: 'm1',
  message: {
    id: 'm1',
    role: 'user',
    blocks: [{ type: 'text', text: 'hello' }],
    streaming: false,
    timestamp: 0
  }
}

describe('Story 5.1 responsive chat layout', () => {
  beforeEach(() => {
    mockMcpCount.current = 2
    installResizeMocks(800)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    restoreResizeMocks()
  })

  it('keeps max-w-3xl + container gutter classes on the thread column (wide non-regression)', () => {
    const { container } = render(
      <TooltipProvider>
        <ChatMessageList
          items={[timelineItem]}
          sessionId="session-1"
          agentId="agent-1"
          showRunningIndicator={false}
        />
      </TooltipProvider>
    )
    expect(container.innerHTML).toContain('max-w-3xl')
    expect(container.innerHTML).toContain(CHAT_GUTTER_X.split(' ')[0]!)
    expect(container.innerHTML).toContain('@[400px]:px-5')
  })

  it('aligns notice / plan gutters with CHAT_GUTTER_X', () => {
    const error = render(<ChatErrorNotice message="boom" onDismiss={vi.fn()} />)
    expect(error.container.innerHTML).toContain('max-w-3xl')
    expect(error.container.innerHTML).toContain('@[400px]:px-5')
    error.unmount()

    const plan = render(
      <PlanPanel entries={[{ content: 'step', status: 'pending', priority: 'low' }]} />
    )
    expect(plan.container.innerHTML).toContain('max-w-3xl')
    expect(plan.container.innerHTML).toContain('@[400px]:px-5')
    plan.unmount()
  })

  it('uses a single toolbar row above ~400px pane width', () => {
    installResizeMocks(560)
    const s = session()
    const configOptions = [
      option('model', 'Model', 'model', 'composer', [{ value: 'composer', name: 'composer-2.5' }]),
      option('thought_level', 'Thinking', 'thought_level', 'high', [
        { value: 'high', name: 'High' }
      ])
    ]

    render(
      <TooltipProvider>
        <ChatInputBar
          session={s}
          busy={false}
          disabled={false}
          onSend={vi.fn()}
          onSendBlocks={vi.fn()}
          onCancel={vi.fn()}
          commands={[]}
          configOptions={configOptions}
          modes={s.modes}
          onSetConfig={vi.fn()}
          onSetMode={vi.fn()}
          onSetModel={vi.fn()}
        />
      </TooltipProvider>
    )

    const toolbar = document.querySelector('[data-composer-toolbar]')
    expect(toolbar).toHaveAttribute('data-composer-toolbar', 'wide')
    expect(toolbar?.querySelector('[data-composer-toolbar-row="single"]')).toBeTruthy()
    expect(toolbar?.querySelector('[data-composer-toolbar-row="1"]')).toBeNull()
    expect(screen.getByRole('button', { name: /Send message/i })).toBeInTheDocument()
  })

  it('uses an explicit two-row toolbar below ~400px pane width', () => {
    installResizeMocks(375)
    const s = session()
    const configOptions = [
      option('model', 'Model', 'model', 'composer', [{ value: 'composer', name: 'composer-2.5' }]),
      option('thought_level', 'Thinking', 'thought_level', 'high', [
        { value: 'high', name: 'High' }
      ])
    ]

    render(
      <TooltipProvider>
        <ChatInputBar
          session={s}
          busy={false}
          disabled={false}
          onSend={vi.fn()}
          onSendBlocks={vi.fn()}
          onCancel={vi.fn()}
          commands={[]}
          configOptions={configOptions}
          modes={s.modes}
          onSetConfig={vi.fn()}
          onSetMode={vi.fn()}
          onSetModel={vi.fn()}
        />
      </TooltipProvider>
    )

    const toolbar = document.querySelector('[data-composer-toolbar]')
    expect(toolbar).toHaveAttribute('data-composer-toolbar', 'narrow')

    const row1 = toolbar?.querySelector('[data-composer-toolbar-row="1"]')
    const row2 = toolbar?.querySelector('[data-composer-toolbar-row="2"]')
    expect(row1).toBeTruthy()
    expect(row2).toBeTruthy()
    expect(toolbar?.querySelector('[data-composer-toolbar-row="single"]')).toBeNull()

    expect(within(row1 as HTMLElement).getByRole('button', { name: /^Agent$/ })).toBeInTheDocument()
    expect(
      within(row1 as HTMLElement).getByRole('button', { name: 'composer-2.5' })
    ).toBeInTheDocument()

    expect(within(row2 as HTMLElement).getByRole('button', { name: 'High' })).toBeInTheDocument()
    expect(within(row2 as HTMLElement).getByText(/MCP servers attached/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Send message/i })).toBeInTheDocument()
  })

  it('switches between narrow and wide when pane width crosses the threshold', () => {
    installResizeMocks(500)
    const s = session()

    render(
      <TooltipProvider>
        <ChatInputBar
          session={s}
          busy={false}
          disabled={false}
          onSend={vi.fn()}
          onSendBlocks={vi.fn()}
          onCancel={vi.fn()}
          commands={[]}
          configOptions={[
            option('model', 'Model', 'model', 'composer', [
              { value: 'composer', name: 'composer-2.5' }
            ])
          ]}
          modes={s.modes}
          onSetConfig={vi.fn()}
          onSetMode={vi.fn()}
          onSetModel={vi.fn()}
        />
      </TooltipProvider>
    )

    expect(document.querySelector('[data-composer-toolbar]')).toHaveAttribute(
      'data-composer-toolbar',
      'wide'
    )

    setMockWidth(NARROW_PANE_PX - 1)
    expect(document.querySelector('[data-composer-toolbar]')).toHaveAttribute(
      'data-composer-toolbar',
      'narrow'
    )

    setMockWidth(640)
    expect(document.querySelector('[data-composer-toolbar]')).toHaveAttribute(
      'data-composer-toolbar',
      'wide'
    )
  })
})
