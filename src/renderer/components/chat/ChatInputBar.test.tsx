import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { SessionConfigOption } from '@/lib/acp-api'
import type { AcpSession } from '@/stores/acp-store'
import { ChatInputBar } from './ChatInputBar'

function clickMenuOption(name: string | RegExp): void {
  const dialog = screen.getByRole('dialog')
  fireEvent.pointerDown(within(dialog).getByText(name))
}

const { mockSetConfig, mockSetMode, mockSetModel, mockMcpCount, mockReadDir } = vi.hoisted(() => ({
  mockSetConfig: vi.fn(),
  mockSetMode: vi.fn(),
  mockSetModel: vi.fn(),
  // Story 1.8 review (verification-gap #8): override-able MCP server count for
  // the read-only badge. 0 by default (badge hidden); tests set it to render.
  mockMcpCount: { current: 0 },
  mockReadDir: vi.fn()
}))

vi.mock('@tauri-apps/plugin-fs', () => ({ readDir: mockReadDir }))

vi.mock('@/hooks/use-agent-skills', () => ({
  useAgentSkills: () => ({ skills: [] }),
  buildPromptWithLoadedSkill: vi.fn(async (_skill, text: string) => text)
}))

vi.mock('@/stores/acp-store', () => ({
  useAgentIdentity: () => ({ name: 'Cursor', templateId: 'cursor' }),
  useSessionUsage: () => null,
  useAcpMessages: () => [],
  // Story 1.8: ChatInputBar reads the global MCP server count for the read-only
  // MCP badge. The selector reads the hoisted `mockMcpCount.current` so a test
  // can override the count (default 0 → badge hidden).
  useAcpStore: (selector: (s: { mcpServers: unknown[] }) => unknown) =>
    selector({ mcpServers: Array.from({ length: mockMcpCount.current }) })
}))

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

describe('ChatInputBar config controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses model config and native Agent/mode picker without duplicate Agent chips', async () => {
    const s = session()
    const configOptions = [
      option('model', 'Model', 'model', 'composer', [
        { value: 'composer', name: 'composer-2.5' },
        { value: 'sonnet', name: 'sonnet-4.5' }
      ]),
      option('mode', 'Agent', 'mode', 'agent', [
        { value: 'agent', name: 'Agent' },
        { value: 'plan', name: 'Plan' },
        { value: 'ask', name: 'Ask' }
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
          onSetConfig={mockSetConfig}
          onSetMode={mockSetMode}
          onSetModel={mockSetModel}
        />
      </TooltipProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'composer-2.5' }))
    clickMenuOption('sonnet-4.5')
    expect(mockSetConfig).toHaveBeenCalledWith('model', 'sonnet')

    mockSetConfig.mockClear()
    expect(screen.getAllByRole('button', { name: /^Agent$/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /^Agent$/ }))
    clickMenuOption('Plan')
    expect(mockSetMode).toHaveBeenCalledWith('plan')
    expect(mockSetConfig).not.toHaveBeenCalled()
  })

  it('searches and scroll-limits large active-chat model menus', async () => {
    const s = session()
    const configOptions = [
      option('model', 'Model', 'model', 'gpt-54-mini-fast', [
        { value: 'gpt-54-mini-fast', name: 'OpenAI/GPT-5.4 mini Fast' },
        { value: 'gpt-55', name: 'OpenAI/GPT-5.5' },
        { value: 'gpt-55-fast', name: 'OpenAI/GPT-5.5 Fast' },
        { value: 'gpt-55-pro', name: 'OpenAI/GPT-5.5 Pro' },
        { value: 'grok-420-non-reasoning', name: 'xAI/Grok 4.20 (Non-Reasoning)' },
        { value: 'grok-420-reasoning', name: 'xAI/Grok 4.20 (Reasoning)' },
        { value: 'grok-43', name: 'xAI/Grok 4.3' },
        { value: 'big-pickle', name: 'OpenCode Zen/Big Pickle' }
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
          onSetConfig={mockSetConfig}
          onSetMode={mockSetMode}
          onSetModel={mockSetModel}
        />
      </TooltipProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'OpenAI/GPT-5.4 mini Fast' }))

    expect(screen.getByLabelText('Search models')).toBeInTheDocument()
    expect(screen.getByTestId('config-chip-model-options')).toHaveClass(
      'max-h-[180px]',
      'overflow-y-auto'
    )

    fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'grok 4.3' } })

    expect(screen.getByText('xAI/Grok 4.3')).toBeInTheDocument()
    expect(screen.queryByText('OpenAI/GPT-5.5 Pro')).not.toBeInTheDocument()
    clickMenuOption('xAI/Grok 4.3')
    expect(mockSetConfig).toHaveBeenCalledWith('model', 'grok-43')
  })

  it('uses native ACP session models when configOptions has no model option', async () => {
    const s = session()
    s.models = {
      currentModelId: 'kiro/claude-opus-4-8',
      availableModels: [
        { modelId: 'kiro/claude-opus-4-8', name: 'kiro/Claude Opus 4.8' },
        { modelId: 'openrouter/gpt-5.5', name: 'OpenRouter/GPT-5.5' }
      ]
    }

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
          configOptions={[]}
          modes={s.modes}
          onSetConfig={mockSetConfig}
          onSetMode={mockSetMode}
          onSetModel={mockSetModel}
        />
      </TooltipProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'kiro/Claude Opus 4.8' }))
    clickMenuOption('OpenRouter/GPT-5.5')

    expect(mockSetModel).toHaveBeenCalledWith('openrouter/gpt-5.5')
    expect(mockSetConfig).not.toHaveBeenCalled()
  })
})

describe('ChatInputBar MCP badge (Story 1.8)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMcpCount.current = 0
  })

  it('hides the MCP badge when no MCP servers are configured', () => {
    mockMcpCount.current = 0
    renderInputBar()
    // The badge returns null at count 0 — no "MCP servers attached" text.
    expect(screen.queryByText(/MCP servers attached/i)).not.toBeInTheDocument()
  })

  it('renders the MCP badge with the count when MCP servers are configured', () => {
    mockMcpCount.current = 2
    renderInputBar()
    // The badge pill shows the count + the sr-only label.
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText(/MCP servers attached/i)).toBeInTheDocument()
  })

  it('prefers the switched session MCP count over the global registry', () => {
    mockMcpCount.current = 5
    renderInputBar({ session: { ...session(), mcpServerCount: 2 } })
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.queryByText('5')).not.toBeInTheDocument()
  })
})

function renderInputBar(props: Partial<ComponentProps<typeof ChatInputBar>> = {}) {
  const s = session()
  return render(
    <TooltipProvider>
      <ChatInputBar
        session={s}
        busy={false}
        disabled={false}
        onSend={vi.fn()}
        onSendBlocks={vi.fn()}
        onCancel={vi.fn()}
        commands={[]}
        configOptions={[]}
        modes={s.modes}
        onSetConfig={mockSetConfig}
        onSetMode={mockSetMode}
        onSetModel={mockSetModel}
        {...props}
      />
    </TooltipProvider>
  )
}

describe('ChatInputBar file mentions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReadDir.mockImplementation(async (path: string) => {
      if (path === '/work') return [{ name: 'src', isDirectory: true }]
      if (path === '/work/src') return [{ name: 'auth.ts', isDirectory: false }]
      return []
    })
  })

  it('stages a selected @ file and sends it as a resource link block', async () => {
    const onSendBlocks = vi.fn()
    renderInputBar({ onSendBlocks })

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'fix @auth' } })

    const option = await screen.findByRole('option', { name: /auth\.ts/ })
    fireEvent.mouseDown(option)

    expect(textarea).toHaveValue('fix ')
    expect(screen.getByText('auth.ts')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => {
      expect(onSendBlocks).toHaveBeenCalledWith([
        { type: 'text', text: 'fix' },
        {
          type: 'resource_link',
          uri: 'file:///work/src/auth.ts',
          name: 'auth.ts',
          mimeType: 'text/typescript'
        }
      ])
    })
  })
})

describe('ChatInputBar morph button', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows a single stop button while busy with an empty composer', () => {
    renderInputBar({ busy: true })

    expect(screen.getByRole('button', { name: 'Cancel turn' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Queue message' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument()
  })

  it('morphs to a single queue send button when the user types during a turn', async () => {
    renderInputBar({ busy: true })

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'follow up' } })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Queue message' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Cancel turn' })).not.toBeInTheDocument()
    })
  })

  it('accepts a drop whose file is exposed only through dataTransfer.items', async () => {
    renderInputBar({ imageCapable: true })
    const file = new File(['screenshot'], 'screenshot.png', { type: 'image/png' })
    const dataTransfer = {
      files: [] as unknown as FileList,
      items: [{ kind: 'file', getAsFile: () => file }]
    } as unknown as DataTransfer

    fireEvent.drop(screen.getByRole('textbox'), { dataTransfer })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'screenshot.png' })).toBeInTheDocument()
    })
  })
})
