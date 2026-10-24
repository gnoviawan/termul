import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { SessionConfigOption } from '@/lib/acp-api'
import type { SupportedAcpAgentEntry } from '@/lib/agents/supported-acp-agents'
import { SelectorPanelV2, type SelectorPanelV2Props } from './SelectorPanelV2'
import type { ModelCatalog } from './selector-model'
import type { SelectorSource } from './selector-source'

// jsdom omits `document.elementFromPoint`; floating-ui calls it.
if (typeof document.elementFromPoint !== 'function') {
  Object.defineProperty(document, 'elementFromPoint', {
    value: () => null,
    configurable: true,
    writable: true
  })
}

const { knownCatalogs } = vi.hoisted(() => ({
  knownCatalogs: { current: new Map<string, ModelCatalog>() }
}))

vi.mock('./use-model-catalog', () => ({
  loadPersistedCatalog: () => {},
  useOtherAgentCatalog: () => ({ catalog: null, error: null, retry: () => {} }),
  useKnownCatalogs: (_cwd: string, ids: readonly string[]) =>
    ids.map((id) => knownCatalogs.current.get(id) ?? null)
}))

vi.mock('@/hooks/use-mobile-web-shell', () => ({ useMobileWebShell: () => false }))

function config(id: string, name: string): StoredAgentConfig {
  return {
    id: `acp-registry:${id}`,
    configId: `acp-registry:${id}`,
    name,
    command: id,
    args: [],
    env: {},
    allowTerminal: false,
    templateId: id
  }
}

function entry(c: StoredAgentConfig): SupportedAcpAgentEntry {
  return {
    id: c.id,
    configId: c.configId ?? c.id,
    agent: {
      id: c.templateId ?? c.id,
      name: c.name,
      version: '',
      description: '',
      distribution: {}
    },
    config: c,
    status: 'ready',
    install: null,
    manualInstall: null,
    runtimeLauncher: null,
    unavailableReason: null
  }
}

const CURSOR = config('cursor', 'Cursor')
const CLAUDE = config('claude-acp', 'Claude Agent')

function select(
  id: string,
  name: string,
  currentValue: string,
  values: Array<[string, string]>,
  category?: string
): SessionConfigOption {
  return {
    id,
    name,
    type: 'select',
    category,
    currentValue,
    options: values.map(([value, label]) => ({ value, name: label }))
  } as SessionConfigOption
}

const MODEL = select('model', 'Model', 'opus', [
  ['opus', 'Claude Opus'],
  ['sonnet', 'Claude Sonnet']
])
const EFFORT = select(
  'thought_level',
  'Effort',
  'high',
  [
    ['low', 'Low'],
    ['medium', 'Medium'],
    ['high', 'High']
  ],
  'thought_level'
)
const contextOption = (current: string, values: Array<[string, string]>): SessionConfigOption =>
  select('context', 'Context', current, values, 'model_config')
const WIDE = contextOption('300k', [
  ['300k', '300K'],
  ['1m', '1M']
])
const NARROW = contextOption('256k', [
  ['256k', '256K'],
  ['500k', '500K']
])

function source(over: Partial<SelectorSource> = {}): SelectorSource {
  return {
    kind: 'draft',
    key: 'test',
    agentConfigs: [CURSOR, CLAUDE],
    entries: [entry(CURSOR), entry(CLAUDE)],
    currentConfigId: CURSOR.id,
    armedConfigId: null,
    blocked: false,
    turnBusy: false,
    installingConfigId: null,
    install: () => {},
    workspace: { cwd: '/p', projectId: 'p' },
    liveCatalog: null,
    pickCurrentModel: () => {},
    pickOtherModel: vi.fn(),
    cancelThenSwitch: async () => {},
    selectAgent: () => {},
    modelStatus: null,
    updateAgentIds: null,
    ...over
  }
}

function props(over: Partial<SelectorPanelV2Props> = {}): SelectorPanelV2Props {
  return {
    source: source(),
    touch: false,
    disabled: false,
    modelOption: MODEL,
    modelValue: 'opus',
    onPickModel: vi.fn(),
    thoughtLevel: EFFORT,
    effortValue: 'high',
    onEffort: vi.fn(),
    fastMode: null,
    fastOn: false,
    onToggleFast: null,
    genericOptions: [WIDE],
    agentConfigId: CURSOR.id,
    onSetConfig: vi.fn(),
    onClose: () => {},
    escapeRef: { current: null },
    ...over
  }
}

function Panel(p: SelectorPanelV2Props): React.JSX.Element {
  return (
    <TooltipProvider>
      <SelectorPanelV2 {...p} />
    </TooltipProvider>
  )
}

/** The panel inside an open Popover, as the composer mounts it. */
function InPicker({
  onOpenChange,
  ...p
}: SelectorPanelV2Props & { onOpenChange: (open: boolean) => void }): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const escapeRef = useRef<(() => boolean) | null>(null)
  return (
    <TooltipProvider>
      <Popover
        open={open}
        onOpenChange={(next) => {
          onOpenChange(next)
          setOpen(next)
        }}
      >
        <PopoverTrigger>picker</PopoverTrigger>
        <PopoverContent>
          <SelectorPanelV2 {...p} escapeRef={escapeRef} />
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  )
}

afterEach(() => {
  cleanup()
  knownCatalogs.current = new Map()
})

describe('SelectorPanelV2 session option rows', () => {
  it('labels Effort and Context from the option data', () => {
    const { rerender } = render(<Panel {...props()} />)
    expect(screen.getByTestId('selector-option-effort')).toHaveAccessibleName('Effort: High')
    expect(screen.getByTestId('selector-option-context')).toHaveAccessibleName('Context: 300K')

    rerender(<Panel {...props({ genericOptions: [NARROW] })} />)
    expect(screen.getByTestId('selector-option-context')).toHaveAccessibleName('Context: 256K')
  })

  it('shows a row only for options the agent sends', () => {
    render(<Panel {...props({ thoughtLevel: null, genericOptions: [] })} />)
    expect(screen.queryByTestId('selector-option-effort')).toBeNull()
    expect(screen.queryByTestId('selector-option-context')).toBeNull()
    expect(screen.queryByTestId('selector-options')).toBeNull()
  })

  it('finds context by id and category, not by its label', () => {
    const renamed = { ...WIDE, name: 'Window' } as SessionConfigOption
    render(<Panel {...props({ genericOptions: [renamed] })} />)
    expect(screen.getByTestId('selector-option-context')).toHaveAccessibleName('Context: 300K')
  })

  it('sends the picked context value through onSetConfig', async () => {
    const onSetConfig = vi.fn()
    render(<Panel {...props({ onSetConfig })} />)
    fireEvent.click(screen.getByTestId('selector-option-context'))
    const menu = await screen.findByRole('menu', { name: 'Context' })
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: '1M' }))
    expect(onSetConfig).toHaveBeenCalledWith('context', '1m')
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Context' })).toBeNull())
  })
})

describe('SelectorPanelV2 flyout keyboard', () => {
  it('ArrowRight opens the flyout on the checked choice', async () => {
    render(<Panel {...props()} />)
    const row = screen.getByTestId('selector-option-effort')
    row.focus()
    fireEvent.keyDown(row, { key: 'ArrowRight' })
    const menu = await screen.findByRole('menu', { name: 'Effort' })
    await waitFor(() =>
      expect(within(menu).getByRole('menuitemradio', { name: 'High' })).toHaveFocus()
    )
    expect(within(menu).getByRole('menuitemradio', { name: 'High' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })

  it('Enter opens the flyout, and Enter on a choice picks it', async () => {
    const onEffort = vi.fn()
    render(<Panel {...props({ onEffort })} />)
    const row = screen.getByTestId('selector-option-effort')
    row.focus()
    // A native button turns Enter into a click; jsdom needs the click itself.
    fireEvent.keyDown(row, { key: 'Enter' })
    fireEvent.click(row)
    const menu = await screen.findByRole('menu', { name: 'Effort' })
    await waitFor(() =>
      expect(within(menu).getByRole('menuitemradio', { name: 'High' })).toHaveFocus()
    )
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' })
    expect(within(menu).getByRole('menuitemradio', { name: 'Medium' })).toHaveFocus()
    fireEvent.click(document.activeElement as HTMLElement)
    expect(onEffort).toHaveBeenCalledWith('medium')
  })

  it('ArrowLeft closes the flyout and returns focus to the row', async () => {
    render(<Panel {...props()} />)
    const row = screen.getByTestId('selector-option-context')
    row.focus()
    fireEvent.keyDown(row, { key: 'ArrowRight' })
    const menu = await screen.findByRole('menu', { name: 'Context' })
    await waitFor(() => expect(within(menu).getAllByRole('menuitemradio')[0]).toHaveFocus())
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' })
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Context' })).toBeNull())
    await waitFor(() => expect(row).toHaveFocus())
  })

  it('Escape closes the flyout first, then the picker', async () => {
    const onOpenChange = vi.fn()
    render(<InPicker {...props()} onOpenChange={onOpenChange} />)
    const row = await screen.findByTestId('selector-option-effort')
    act(() => row.focus())
    fireEvent.keyDown(row, { key: 'ArrowRight' })
    const menu = await screen.findByRole('menu', { name: 'Effort' })
    await waitFor(() =>
      expect(within(menu).getByRole('menuitemradio', { name: 'High' })).toHaveFocus()
    )

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Effort' })).toBeNull())
    expect(onOpenChange).not.toHaveBeenCalled()
    await waitFor(() => expect(row).toHaveFocus())

    fireEvent.keyDown(row, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('Up and Down move between footer rows', () => {
    render(<Panel {...props()} />)
    const effort = screen.getByTestId('selector-option-effort')
    const context = screen.getByTestId('selector-option-context')
    effort.focus()
    fireEvent.keyDown(effort, { key: 'ArrowDown' })
    expect(context).toHaveFocus()
    fireEvent.keyDown(context, { key: 'ArrowUp' })
    expect(effort).toHaveFocus()
  })
})

describe('SelectorPanelV2 favorites', () => {
  it('lists favorites above the agent models, keyed by config id', () => {
    knownCatalogs.current = new Map([
      [
        CLAUDE.id,
        {
          id: 'model',
          source: 'config',
          currentValue: null,
          options: [{ value: 'claude-opus', name: 'Opus via Claude' }]
        } as ModelCatalog
      ]
    ])
    render(
      <Panel
        {...props({
          favorites: [
            { configId: CLAUDE.id, value: 'claude-opus' },
            { configId: CURSOR.id, value: 'sonnet' },
            { configId: CURSOR.id, value: 'gone' }
          ]
        })}
      />
    )
    const list = screen.getByTestId('selector-list')
    expect(within(list).getByText('Favorites')).toBeInTheDocument()
    const names = within(list)
      .getAllByRole('button')
      .map((b) => b.textContent?.trim())
    expect(names.slice(0, 2)).toEqual(['Opus via ClaudeClaude Agent', 'Claude Sonnet'])
    expect(names).not.toContain('gone')
  })

  it('hides the Favorites section while searching', () => {
    render(<Panel {...props({ favorites: [{ configId: CURSOR.id, value: 'sonnet' }] })} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models and agents' }), {
      target: { value: 'opus' }
    })
    expect(screen.queryByText('Favorites')).toBeNull()
  })
})
