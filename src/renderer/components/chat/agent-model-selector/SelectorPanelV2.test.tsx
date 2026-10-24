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

const FAST = {
  id: 'fast',
  name: 'Fast',
  type: 'boolean',
  currentValue: false
} as unknown as SessionConfigOption

/** The active (checked) model row. */
const activeRow = (): HTMLElement =>
  screen.getByRole('button', { name: 'Claude Opus', pressed: true })

async function openEdit(): Promise<HTMLElement> {
  const edit = screen.getByTestId('selector-edit')
  // A native button turns Enter into a click; jsdom needs the click itself.
  fireEvent.keyDown(edit, { key: 'Enter' })
  fireEvent.click(edit)
  return screen.findByTestId('selector-edit-flyout')
}

describe('SelectorPanelV2 Edit flyout', () => {
  it('shows Edit only on the active model row', () => {
    render(<Panel {...props()} />)
    const edits = screen.getAllByTestId('selector-edit')
    expect(edits).toHaveLength(1)
    expect(edits[0]).toHaveAccessibleName('Edit Thinking and Context for Claude Opus')
    expect(edits[0]?.parentElement).toContainElement(activeRow())
    // Thinking and Context left the footer.
    expect(screen.queryByTestId('selector-option-effort')).toBeNull()
    expect(screen.queryByTestId('selector-option-context')).toBeNull()
  })

  it('labels Thinking and Context choices from the option data', async () => {
    const { rerender } = render(<Panel {...props()} />)
    const flyout = await openEdit()
    const thinking = within(flyout).getByRole('group', { name: 'Thinking' })
    expect(within(thinking).getByRole('menuitemradio', { name: 'High' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    const context = within(flyout).getByRole('group', { name: 'Context' })
    expect(
      within(context)
        .getAllByRole('menuitemradio')
        .map((item) => item.textContent)
    ).toEqual(['300K', '1M'])
    expect(within(context).getByRole('menuitemradio', { name: '300K' })).toHaveAttribute(
      'aria-checked',
      'true'
    )

    rerender(<Panel {...props({ genericOptions: [NARROW] })} />)
    const narrow = within(screen.getByTestId('selector-edit-flyout')).getByRole('group', {
      name: 'Context'
    })
    expect(
      within(narrow)
        .getAllByRole('menuitemradio')
        .map((item) => item.textContent)
    ).toEqual(['256K', '500K'])
  })

  it('hides a section the agent does not send, and Edit when none is sent', async () => {
    const { rerender } = render(<Panel {...props({ thoughtLevel: null })} />)
    expect(screen.getByTestId('selector-edit')).toHaveAccessibleName('Edit Context for Claude Opus')
    const flyout = await openEdit()
    expect(within(flyout).getByRole('menu', { name: 'Context' })).toBeInTheDocument()
    expect(within(flyout).queryByRole('group')).toBeNull()

    rerender(<Panel {...props({ thoughtLevel: null, genericOptions: [] })} />)
    expect(screen.queryByTestId('selector-edit')).toBeNull()
    expect(screen.queryByTestId('selector-options')).toBeNull()
  })

  it('with only Fast, Edit still shows and the flyout holds just Fast', async () => {
    const onToggleFast = vi.fn()
    render(
      <Panel {...props({ thoughtLevel: null, genericOptions: [], fastMode: FAST, onToggleFast })} />
    )
    expect(screen.getByTestId('selector-edit')).toHaveAccessibleName('Edit Fast for Claude Opus')
    const flyout = await openEdit()
    expect(within(flyout).queryAllByRole('menuitemradio')).toHaveLength(0)
    const fast = within(flyout).getByRole('menuitemcheckbox', { name: 'Fast' })
    expect(within(flyout).getAllByRole('menuitemcheckbox')).toHaveLength(1)
    expect(fast).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(fast)
    expect(onToggleFast).toHaveBeenCalledTimes(1)
    // Fast moved off the footer too.
    expect(screen.queryByTestId('selector-option-fast')).toBeNull()
  })

  it('finds context by id and category, not by its label', async () => {
    const renamed = { ...WIDE, name: 'Window' } as SessionConfigOption
    render(<Panel {...props({ genericOptions: [renamed] })} />)
    const flyout = await openEdit()
    const context = within(flyout).getByRole('group', { name: 'Context' })
    expect(within(context).getByRole('menuitemradio', { name: '300K' })).toBeInTheDocument()
  })

  it('sends the picked context value through onSetConfig and stays open', async () => {
    const onSetConfig = vi.fn()
    render(<Panel {...props({ onSetConfig })} />)
    const flyout = await openEdit()
    fireEvent.click(within(flyout).getByRole('menuitemradio', { name: '1M' }))
    expect(onSetConfig).toHaveBeenCalledWith('context', '1m')
    expect(screen.getByTestId('selector-edit-flyout')).toBeInTheDocument()
  })
})

describe('SelectorPanelV2 Edit flyout keyboard', () => {
  it('ArrowRight on the active row opens on the checked Thinking choice', async () => {
    render(<Panel {...props()} />)
    const row = activeRow()
    row.focus()
    fireEvent.keyDown(row, { key: 'ArrowRight' })
    const flyout = await screen.findByTestId('selector-edit-flyout')
    await waitFor(() =>
      expect(within(flyout).getByRole('menuitemradio', { name: 'High' })).toHaveFocus()
    )
    // Down runs on from Thinking into Context.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' })
    expect(within(flyout).getByRole('menuitemradio', { name: '300K' })).toHaveFocus()
  })

  it('ArrowRight on another row opens nothing', () => {
    render(<Panel {...props()} />)
    const other = screen.getByRole('button', { name: 'Claude Sonnet' })
    other.focus()
    fireEvent.keyDown(other, { key: 'ArrowRight' })
    expect(screen.queryByTestId('selector-edit-flyout')).toBeNull()
  })

  it('Enter on Edit opens the flyout, and Enter on a choice picks it', async () => {
    const onEffort = vi.fn()
    render(<Panel {...props({ onEffort })} />)
    const flyout = await openEdit()
    await waitFor(() =>
      expect(within(flyout).getByRole('menuitemradio', { name: 'High' })).toHaveFocus()
    )
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' })
    expect(within(flyout).getByRole('menuitemradio', { name: 'Medium' })).toHaveFocus()
    fireEvent.click(document.activeElement as HTMLElement)
    expect(onEffort).toHaveBeenCalledWith('medium')
  })

  it('ArrowLeft closes the flyout and returns focus to the row', async () => {
    render(<Panel {...props()} />)
    const row = activeRow()
    row.focus()
    fireEvent.keyDown(row, { key: 'ArrowRight' })
    const flyout = await screen.findByTestId('selector-edit-flyout')
    await waitFor(() => expect(within(flyout).getAllByRole('menuitemradio')[2]).toHaveFocus())
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' })
    await waitFor(() => expect(screen.queryByTestId('selector-edit-flyout')).toBeNull())
    await waitFor(() => expect(row).toHaveFocus())
  })

  it('Escape closes the flyout first, then the picker', async () => {
    const onOpenChange = vi.fn()
    render(<InPicker {...props()} onOpenChange={onOpenChange} />)
    const row = await screen.findByRole('button', { name: 'Claude Opus', pressed: true })
    act(() => row.focus())
    fireEvent.keyDown(row, { key: 'ArrowRight' })
    const flyout = await screen.findByTestId('selector-edit-flyout')
    await waitFor(() =>
      expect(within(flyout).getByRole('menuitemradio', { name: 'High' })).toHaveFocus()
    )

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('selector-edit-flyout')).toBeNull())
    expect(onOpenChange).not.toHaveBeenCalled()
    await waitFor(() => expect(row).toHaveFocus())

    fireEvent.keyDown(row, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('Up and Down move between the remaining footer rows', () => {
    const mode = select('mode', 'Mode', 'agent', [
      ['agent', 'Agent'],
      ['plan', 'Plan']
    ])
    const sandbox = { ...FAST, id: 'sandbox', name: 'Sandbox' } as SessionConfigOption
    render(<Panel {...props({ genericOptions: [WIDE, mode, sandbox] })} />)
    const modeRow = screen.getByTestId('selector-option-mode')
    const sandboxRow = screen.getByTestId('selector-option-sandbox')
    expect(modeRow).toHaveAccessibleName('Mode: Agent')
    modeRow.focus()
    fireEvent.keyDown(modeRow, { key: 'ArrowDown' })
    expect(sandboxRow).toHaveFocus()
    fireEvent.keyDown(sandboxRow, { key: 'ArrowUp' })
    expect(modeRow).toHaveFocus()
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
    expect(names.slice(0, 2)).toEqual(['Opus via Claude · Claude Agent', 'Claude Sonnet'])
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
