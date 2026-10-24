import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { SessionConfigOption } from '@/lib/acp-api'
import type { SupportedAcpAgentEntry } from '@/lib/agents/supported-acp-agents'
import {
  createFavoritesStore,
  type FavoritesStore,
  memoryFavoritesAdapter
} from './favorite-models'
import { SelectorPanel } from './SelectorPanel'
import { SelectorPanelV2, type SelectorPanelV2Props } from './SelectorPanelV2'
import {
  AGENT_TRACK,
  AGENT_TRACK_CLASS,
  agentTrackCapacity,
  type ModelCatalog
} from './selector-model'
import type { SelectorSource } from './selector-source'
import { PICKER_LABEL, PICKER_ROW, PICKER_SURFACE } from './selector-tokens'

// jsdom omits `document.elementFromPoint`; floating-ui calls it.
if (typeof document.elementFromPoint !== 'function') {
  Object.defineProperty(document, 'elementFromPoint', {
    value: () => null,
    configurable: true,
    writable: true
  })
}

const { knownCatalogs, stored } = vi.hoisted(() => ({
  knownCatalogs: { current: new Map<string, ModelCatalog>() },
  /** The persistence store: rejected option values per agent. */
  stored: new Map<string, unknown>()
}))

vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>()
  return {
    ...actual,
    persistenceApi: {
      read: async (key: string) =>
        stored.has(key) ? { success: true, data: stored.get(key) } : { success: true, data: null },
      write: async (key: string, data: unknown) => {
        stored.set(key, data)
        return { success: true }
      }
    }
  }
})

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

/** An in-memory favorites store, starred in the given order. */
function storeOf(pairs: Array<[string, string]>): FavoritesStore {
  return createFavoritesStore(
    memoryFavoritesAdapter(
      pairs.map(([configId, modelId], i) => ({
        configId,
        modelId,
        addedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()
      }))
    )
  )
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
  stored.clear()
})

const FAST = {
  id: 'fast',
  name: 'Fast',
  type: 'boolean',
  currentValue: false
} as unknown as SessionConfigOption

/** The active (checked) model row. */
const activeRow = (): HTMLElement =>
  screen.getByRole('button', { name: 'Claude Opus, thinking High', pressed: true })

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
    expect(screen.getByTestId('selector-edit')).toHaveAccessibleName(
      'Edit Fast mode for Claude Opus'
    )
    const flyout = await openEdit()
    expect(within(flyout).queryAllByRole('menuitemradio')).toHaveLength(0)
    const fast = within(flyout).getByRole('menuitemcheckbox', { name: 'Fast mode' })
    expect(within(flyout).getAllByRole('menuitemcheckbox')).toHaveLength(1)
    // Under prefers-reduced-motion the flyout switch thumb jumps instead of sliding.
    expect(fast.querySelector('.switch-thumb')).toHaveClass('motion-reduce:transition-none')
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

const classes = (el: Element | null | undefined): string[] => (el?.className ?? '').split(/\s+/)

describe('SelectorPanelV2 sizes: flyout matches the list', () => {
  it('flyout choices, labels and switch use the same tokens as the panel rows', async () => {
    const onToggleFast = vi.fn()
    render(
      <Panel
        {...props({
          fastMode: FAST,
          onToggleFast,
          favoritesStore: storeOf([[CURSOR.id, 'sonnet']])
        })}
      />
    )
    const row = classes(activeRow())
    const flyout = await openEdit()
    // The flyout is portaled out of the panel, so it carries the text size itself.
    expect(classes(within(flyout).getByRole('menu'))).toContain(PICKER_ROW.text)
    const choices = [
      ...within(flyout).getAllByRole('menuitemradio'),
      within(flyout).getByRole('menuitemcheckbox', { name: 'Fast mode' })
    ]
    for (const choice of choices) {
      for (const token of [
        PICKER_ROW.text,
        PICKER_ROW.height,
        PICKER_ROW.padX,
        PICKER_ROW.radius
      ]) {
        expect(classes(choice)).toContain(token)
        expect(row).toContain(token)
      }
    }
    // Thinking and Context are styled like the list's own group labels.
    const thinking = within(flyout).getByText('Thinking')
    expect(thinking.className).toBe(PICKER_LABEL)
    expect(screen.getByText('Favorites').className).toBe(PICKER_LABEL)
    // The check is the list's 14px; the switch is the small 28x16 one.
    expect(
      within(flyout).getByRole('menuitemradio', { name: 'High' }).querySelector('svg')
    ).toHaveAttribute('width', '14')
    const mark = within(flyout)
      .getByRole('menuitemcheckbox', { name: 'Fast mode' })
      .querySelector('[data-switch-size]')
    expect(mark).toHaveAttribute('data-switch-size', 'sm')
    expect(classes(mark)).toEqual(expect.arrayContaining(['h-4', 'w-7']))
    // The toggle sits under a full-width separator, not a bordered row.
    expect(within(flyout).getByRole('separator')).toHaveClass('border-t', 'border-border')
    // Same radius as the panel; hugs its content with a 180px floor.
    // (The test id sits on the positioned shell; the surface is its animated child.)
    const surface = classes(flyout.firstElementChild)
    expect(surface).toEqual(expect.arrayContaining([PICKER_SURFACE.radius, 'min-w-45']))
    expect(surface).not.toContain('w-44')
  })
})

describe('SelectorPanelV2 no horizontal overflow', () => {
  it('the list clips sideways and every model name truncates inside its row', () => {
    render(<Panel {...props()} />)
    const list = screen.getByTestId('selector-list')
    expect(classes(list)).toEqual(
      expect.arrayContaining(['min-w-0', 'overflow-y-auto', 'overflow-x-hidden'])
    )
    const names = list.querySelectorAll('[data-row-name]')
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      // `relative` holds the sr-only agent name inside the clipped span.
      expect(classes(name)).toEqual(
        expect.arrayContaining(['relative', 'min-w-0', 'flex-1', 'truncate'])
      )
    }
  })

  it('a very long model name keeps its star and Edit buttons in the row', () => {
    const long = Array(3)
      .fill('Claude Opus 4.7 with 1M context and extended thinking, preview build')
      .join(' ')
    const model = select('model', 'Model', 'opus', [
      ['opus', long],
      ['sonnet', 'Claude Sonnet']
    ])
    render(<Panel {...props({ modelOption: model, favoritesStore: storeOf([]) })} />)
    const row = screen.getByRole('button', { pressed: true })
    // The real name, then the level; read once.
    expect(row).toHaveAccessibleName(`${long}, thinking High`)
    const fav = row.closest<HTMLElement>('[class*="group/fav"]')
    expect(classes(fav)).toContain('min-w-0')
    const star = within(fav as HTMLElement).getByRole('button', { name: 'Add to favorites' })
    expect(star).toBeInTheDocument()
    expect(star).not.toHaveAttribute('hidden')
    // Laid over a slot the row always reserves (shrink-0), so a long name
    // truncates before it instead of pushing it out of the 300px panel.
    expect(classes(star)).toEqual(expect.arrayContaining(['absolute', 'right-7.5', 'w-5']))
    const slot = row.querySelector('[data-row-thinking] + span[aria-hidden="true"]')
    expect(classes(slot)).toEqual(expect.arrayContaining(['shrink-0', 'w-5']))
    const name = row.querySelector('[data-row-name]')
    expect(classes(name)).toEqual(expect.arrayContaining(['min-w-0', 'truncate']))
    // The Thinking level stays whole beside the truncating name.
    const level = row.querySelector('[data-row-thinking]')
    expect(level).toHaveTextContent('High')
    expect(classes(level)).toEqual(expect.arrayContaining(['shrink-0', 'whitespace-nowrap']))
    expect(classes(level)).not.toContain('sr-only')
    const edit = screen.getByTestId('selector-edit')
    // Present and drawn: not hidden, not screen-reader only, never squeezed out.
    expect(edit).toBeInTheDocument()
    expect(edit).not.toHaveAttribute('hidden')
    expect(classes(edit)).not.toContain('sr-only')
    expect(classes(edit)).toContain('shrink-0')
    expect(edit.parentElement).toContainElement(row)
    expect(classes(edit.parentElement)).toContain('min-w-0')
    expect(classes(row)).toEqual(expect.arrayContaining(['min-w-0', 'flex-1']))
  })
})

describe('SelectorPanelV2 Thinking level on the selected row', () => {
  const levels = (): HTMLElement[] =>
    Array.from(
      screen.getByTestId('selector-list').querySelectorAll<HTMLElement>('[data-row-thinking]')
    )

  it('reads exactly "<name>, thinking <level>" for a short name', () => {
    render(<Panel {...props()} />)
    expect(screen.getByRole('button', { pressed: true })).toHaveAccessibleName(
      'Claude Opus, thinking High'
    )
  })

  it('drops edge whitespace an agent sends in a model name', () => {
    const model = select('model', 'Model', 'opus', [
      ['opus', '  Claude Opus  '],
      ['sonnet', 'Claude Sonnet']
    ])
    render(<Panel {...props({ modelOption: model })} />)
    const row = screen.getByRole('button', { pressed: true })
    expect(row).toHaveAccessibleName('Claude Opus, thinking High')
    expect(row.querySelector('[data-row-name]')?.textContent).toBe('Claude Opus, thinking High')
    expect(screen.getByTestId('selector-edit')).toHaveAccessibleName(
      'Edit Thinking and Context for Claude Opus'
    )
  })

  it('shows only on the selected row, after the name, muted and aria-hidden', () => {
    render(<Panel {...props()} />)
    expect(levels()).toHaveLength(1)
    const [level] = levels()
    expect(activeRow()).toContainElement(level ?? null)
    expect(level).toHaveTextContent('High')
    expect(level).toHaveAttribute('aria-hidden', 'true')
    expect(classes(level)).toEqual(
      expect.arrayContaining([
        'shrink-0',
        'whitespace-nowrap',
        'tabular-nums',
        'text-xs',
        'text-muted-foreground'
      ])
    )
    // Name, then the level, then the check.
    const name = activeRow().querySelector('[data-row-name]')
    expect(name?.nextElementSibling).toBe(level)
    expect(screen.getByRole('button', { name: 'Claude Sonnet' })).not.toContainElement(
      level ?? null
    )
  })

  it("keeps the model's real name in the accessible name, read once", () => {
    const model = select('model', 'Model', 'opus', [['opus', 'Claude 4.7 Opus Thinking']])
    const effort = select(
      'thought_level',
      'Effort',
      'xhigh',
      [
        ['high', 'High'],
        ['xhigh', 'Extra High']
      ],
      'thought_level'
    )
    render(<Panel {...props({ modelOption: model, thoughtLevel: effort, effortValue: 'xhigh' })} />)
    const row = screen.getByRole('button', { pressed: true })
    expect(row).toHaveAccessibleName('Claude 4.7 Opus Thinking, thinking Extra High')
    expect(row.querySelector('[data-row-thinking]')).toHaveTextContent('Extra High')
  })

  it('updates after Thinking changes in the Edit flyout', async () => {
    function Live(): React.JSX.Element {
      const [effort, setEffort] = useState('high')
      return <Panel {...props({ effortValue: effort, onEffort: setEffort })} />
    }
    render(<Live />)
    const flyout = await openEdit()
    fireEvent.click(within(flyout).getByRole('menuitemradio', { name: 'Low' }))
    await waitFor(() => expect(levels()[0]).toHaveTextContent('Low'))
    expect(levels()).toHaveLength(1)
    expect(
      screen.getByRole('button', { name: 'Claude Opus, thinking Low', pressed: true })
    ).toBeInTheDocument()
  })

  it('shows nothing without a thinking option, or without a current value', () => {
    const { rerender } = render(
      <Panel {...props({ thoughtLevel: null, effortValue: undefined })} />
    )
    expect(levels()).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Claude Opus', pressed: true })).toBeInTheDocument()
    // An option with no known value: no guessed default.
    rerender(<Panel {...props({ effortValue: undefined })} />)
    expect(levels()).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Claude Opus', pressed: true })).toBeInTheDocument()
  })

  it('shows on the selected model in Favorites too, never on other favorites', () => {
    render(
      <Panel
        {...props({
          favoritesStore: storeOf([
            [CURSOR.id, 'opus'],
            [CURSOR.id, 'sonnet']
          ])
        })}
      />
    )
    const selected = screen.getAllByRole('button', {
      name: 'Claude Opus, thinking High',
      pressed: true
    })
    expect(selected).toHaveLength(2)
    expect(levels()).toHaveLength(2)
    for (const row of selected) {
      expect(row).toHaveAccessibleName('Claude Opus, thinking High')
      expect(row.querySelector('[data-row-thinking]')).toHaveTextContent('High')
    }
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
    const row = await screen.findByRole('button', {
      name: 'Claude Opus, thinking High',
      pressed: true
    })
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
          favoritesStore: storeOf([
            [CLAUDE.id, 'claude-opus'],
            [CURSOR.id, 'sonnet'],
            [CURSOR.id, 'gone']
          ])
        })}
      />
    )
    const list = screen.getByTestId('selector-list')
    expect(within(list).getByText('Favorites')).toBeInTheDocument()
    const names = Array.from(list.querySelectorAll('[data-selector-row]')).map((b) =>
      b.textContent?.trim()
    )
    expect(names.slice(0, 2)).toEqual(['Opus via Claude · Claude Agent', 'Claude Sonnet'])
    expect(names).not.toContain('gone')
  })

  it('hides the Favorites section while searching', () => {
    render(<Panel {...props({ favoritesStore: storeOf([[CURSOR.id, 'sonnet']]) })} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models and agents' }), {
      target: { value: 'opus' }
    })
    expect(screen.queryByText('Favorites')).toBeNull()
  })
})

describe('SelectorPanelV2 favorite star', () => {
  const favoriteRows = (): HTMLElement[] =>
    Array.from(
      screen.getByTestId('selector-list').querySelectorAll<HTMLElement>('[data-favorite-entry]')
    )
  const favoriteNames = (): string[] =>
    // Names as read aloud: the visible Thinking level is aria-hidden.
    favoriteRows().map((row) => row.querySelector('[data-row-name]')?.textContent?.trim() ?? '')
  const starOf = (row: HTMLElement): HTMLElement => within(row).getByTestId('selector-favorite')
  const listRow = (name: string): HTMLElement => {
    const rows = Array.from(
      screen.getByTestId('selector-list').querySelectorAll<HTMLElement>('[data-selector-row]')
    ).filter(
      (row) =>
        row.querySelector('[data-row-name]')?.textContent?.trim() === name &&
        !row.closest('[data-favorite-entry]')
    )
    return rows[0] as HTMLElement
  }

  it('stars a model into Favorites and back out, without picking it', async () => {
    const store = storeOf([])
    const onPickModel = vi.fn()
    render(<Panel {...props({ favoritesStore: store, onPickModel })} />)
    expect(screen.queryByText('Favorites')).toBeNull()
    const star = listRow('Claude Sonnet').parentElement?.querySelector<HTMLElement>(
      '[data-testid="selector-favorite"]'
    ) as HTMLElement
    expect(star).toHaveAttribute('aria-pressed', 'false')
    expect(star).toHaveAccessibleName('Add to favorites')
    await act(async () => fireEvent.click(star))
    expect(favoriteNames()).toEqual(['Claude Sonnet'])
    expect(star).toHaveAttribute('aria-pressed', 'true')
    expect(star).toHaveAccessibleName('Remove from favorites')
    expect(store.list()).toEqual([
      expect.objectContaining({ configId: CURSOR.id, modelId: 'sonnet' })
    ])
    // The Favorites row's own star is filled and pressed.
    expect(starOf(favoriteRows()[0] as HTMLElement)).toHaveAttribute('aria-pressed', 'true')
    await act(async () => fireEvent.click(star))
    expect(screen.queryByText('Favorites')).toBeNull()
    expect(store.list()).toEqual([])
    expect(onPickModel).not.toHaveBeenCalled()
    // The chosen model is still the chosen one.
    expect(listRow('Claude Opus, thinking High')).toHaveAttribute('aria-pressed', 'true')
  })

  it('the star is a sibling of the row button, never inside it', () => {
    render(<Panel {...props({ favoritesStore: storeOf([]) })} />)
    for (const star of screen.getAllByTestId('selector-favorite')) {
      expect(star.closest('[data-selector-row]')).toBeNull()
    }
  })

  it('after unstarring in Favorites, focus moves to the next favorite, else the previous, else the list', async () => {
    knownCatalogs.current = new Map([[CLAUDE.id, CLAUDE_CATALOG]])
    render(
      <Panel
        {...props({
          favoritesStore: storeOf([
            [CLAUDE.id, 'claude-opus'],
            [CURSOR.id, 'sonnet'],
            [CURSOR.id, 'opus']
          ])
        })}
      />
    )
    expect(favoriteNames()).toEqual([
      'Opus via Claude · Claude Agent',
      'Claude Sonnet',
      'Claude Opus, thinking High'
    ])
    // First: the next favorite takes focus.
    await act(async () => fireEvent.click(starOf(favoriteRows()[0] as HTMLElement)))
    expect(favoriteNames()).toEqual(['Claude Sonnet', 'Claude Opus, thinking High'])
    expect(favoriteRows()[0]?.querySelector('[data-selector-row]')).toHaveFocus()
    // Last: the previous one does.
    await act(async () => fireEvent.click(starOf(favoriteRows()[1] as HTMLElement)))
    expect(favoriteNames()).toEqual(['Claude Sonnet'])
    expect(favoriteRows()[0]?.querySelector('[data-selector-row]')).toHaveFocus()
    // None left: the first list row.
    await act(async () => fireEvent.click(starOf(favoriteRows()[0] as HTMLElement)))
    expect(favoriteRows()).toEqual([])
    expect(screen.getByTestId('selector-list').querySelector('[data-selector-row]')).toHaveFocus()
  })

  it('a failed write puts the star back', async () => {
    const store = createFavoritesStore({
      load: () => [],
      put: () => Promise.reject(new Error('offline')),
      remove: () => Promise.resolve()
    })
    render(<Panel {...props({ favoritesStore: store })} />)
    const star = listRow('Claude Sonnet').parentElement?.querySelector<HTMLElement>(
      '[data-testid="selector-favorite"]'
    ) as HTMLElement
    await act(async () => fireEvent.click(star))
    await waitFor(() => expect(star).toHaveAttribute('aria-pressed', 'false'))
    expect(screen.queryByText('Favorites')).toBeNull()
  })
})

/** Resolves or rejects a pending set from the test. */
function deferred(): {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
} {
  let resolve = (): void => {}
  let reject = (_error: Error): void => {}
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('SelectorPanelV2 with no active row', () => {
  it('with no models, Thinking and Fast mode move into the footer', () => {
    const onEffort = vi.fn()
    const onToggleFast = vi.fn()
    render(
      <Panel
        {...props({
          modelOption: null,
          modelValue: undefined,
          genericOptions: [],
          fastMode: FAST,
          onToggleFast,
          onEffort
        })}
      />
    )
    expect(screen.getByText('This agent gives no model choice.')).toBeInTheDocument()
    expect(screen.queryByTestId('selector-edit')).toBeNull()
    const footer = screen.getByTestId('selector-options')
    expect(within(footer).getByTestId('selector-option-thinking')).toHaveAccessibleName(
      'Thinking: High'
    )
    const fast = within(footer).getByRole('switch', { name: 'Fast mode' })
    // Under prefers-reduced-motion the thumb jumps instead of sliding.
    expect(fast.querySelector('.switch-thumb')).toHaveClass('motion-reduce:transition-none')
    fireEvent.click(fast)
    expect(onToggleFast).toHaveBeenCalledTimes(1)
  })

  it('with a model value outside the list, Context is in the footer', () => {
    render(<Panel {...props({ modelValue: 'retired', thoughtLevel: null })} />)
    expect(screen.queryByTestId('selector-edit')).toBeNull()
    expect(screen.getByTestId('selector-option-context')).toHaveAccessibleName('Context: 300K')
  })

  it('shows Default, not "undefined", for a context with no current value', async () => {
    const unset = { ...WIDE, currentValue: undefined } as unknown as SessionConfigOption
    const { rerender } = render(<Panel {...props({ genericOptions: [unset] })} />)
    const flyout = await openEdit()
    const context = within(flyout).getByRole('group', { name: 'Context' })
    for (const item of within(context).getAllByRole('menuitemradio')) {
      expect(item).toHaveAttribute('aria-checked', 'false')
    }
    rerender(<Panel {...props({ modelValue: 'retired', genericOptions: [unset] })} />)
    expect(screen.getByTestId('selector-option-context')).toHaveAccessibleName('Context: Default')
  })
})

describe('SelectorPanelV2 rejected values and optimistic switches', () => {
  it('hides a context value the agent rejects, and remembers it per agent', async () => {
    const onSetConfig = vi.fn(async () => {
      throw new Error('not supported')
    })
    render(<Panel {...props({ onSetConfig })} />)
    let flyout = await openEdit()
    fireEvent.click(within(flyout).getByRole('menuitemradio', { name: '1M' }))
    expect(onSetConfig).toHaveBeenCalledWith('context', '1m')
    flyout = screen.getByTestId('selector-edit-flyout')
    await waitFor(() =>
      expect(within(flyout).queryByRole('menuitemradio', { name: '1M' })).toBeNull()
    )
    await waitFor(() => expect(stored.size).toBe(1))
    expect([...stored.values()]).toEqual([{ context: ['1m'] }])

    // A fresh panel for the same agent opens with the value already hidden.
    cleanup()
    render(<Panel {...props()} />)
    const reopened = await openEdit()
    await waitFor(() =>
      expect(within(reopened).queryByRole('menuitemradio', { name: '1M' })).toBeNull()
    )
    expect(within(reopened).getByRole('menuitemradio', { name: '300K' })).toBeInTheDocument()
  })

  it('keeps a rejected value that is still current, disabled', async () => {
    const onSetConfig = vi.fn(async () => {
      throw new Error('not supported')
    })
    const { rerender } = render(<Panel {...props({ onSetConfig, thoughtLevel: null })} />)
    const flyout = await openEdit()
    fireEvent.click(within(flyout).getByRole('menuitemradio', { name: '1M' }))
    await waitFor(() => expect(stored.size).toBe(1))
    rerender(
      <Panel
        {...props({
          onSetConfig,
          thoughtLevel: null,
          genericOptions: [
            contextOption('1m', [
              ['300k', '300K'],
              ['1m', '1M']
            ])
          ]
        })}
      />
    )
    const current = within(screen.getByTestId('selector-edit-flyout')).getByRole('menuitemradio', {
      name: '1M — Not available for this agent'
    })
    expect(current).toBeDisabled()
    expect(current).toHaveAttribute('aria-checked', 'true')

    // Reopened, focus skips the disabled current value to the first enabled one.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' })
    await waitFor(() => expect(screen.queryByTestId('selector-edit-flyout')).toBeNull())
    const reopened = await openEdit()
    await waitFor(() =>
      expect(within(reopened).getByRole('menuitemradio', { name: '300K' })).toHaveFocus()
    )
  })

  it('a boolean option flips at once, and reverts when the agent rejects it', async () => {
    const pending = deferred()
    const onSetConfig = vi.fn(() => pending.promise)
    const sandbox = { ...FAST, id: 'sandbox', name: 'Sandbox' } as SessionConfigOption
    render(<Panel {...props({ onSetConfig, genericOptions: [sandbox] })} />)
    const toggle = screen.getByRole('switch', { name: 'Sandbox' })
    fireEvent.click(toggle)
    expect(onSetConfig).toHaveBeenCalledWith('sandbox', true)
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await act(async () => {
      pending.reject(new Error('not supported'))
      await pending.promise.catch(() => undefined)
    })
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
  })

  it('the Fast mode item in the flyout flips at once, and reverts on a rejection', async () => {
    const pending = deferred()
    // The composer's toggle is typed void; a pending one still gets the revert.
    const onToggleFast = vi.fn(() => pending.promise) as unknown as () => void
    render(<Panel {...props({ fastMode: FAST, onToggleFast })} />)
    const flyout = await openEdit()
    const fast = within(flyout).getByRole('menuitemcheckbox', { name: 'Fast mode' })
    fireEvent.click(fast)
    expect(fast).toHaveAttribute('aria-checked', 'true')
    await act(async () => {
      pending.reject(new Error('rejected'))
      await pending.promise.catch(() => undefined)
    })
    await waitFor(() => expect(fast).toHaveAttribute('aria-checked', 'false'))
  })
})

const CLAUDE_CATALOG = {
  id: 'model',
  source: 'config',
  currentValue: null,
  options: [{ value: 'claude-opus', name: 'Opus via Claude' }]
} as ModelCatalog

/** Each list row's agent, read from its glyph slot, by row name. */
const rowAgents = (): Array<[string, string | null]> =>
  Array.from(
    screen.getByTestId('selector-list').querySelectorAll<HTMLElement>('[data-selector-row]')
  ).map((row) => {
    const slot = row.querySelector<HTMLElement>('[data-row-agent]')
    expect(slot?.firstElementChild).not.toBeNull()
    // The name as read aloud: the visible Thinking level is aria-hidden.
    const name = row.querySelector('[data-row-name]')
    return [name?.textContent?.trim() ?? '', slot?.dataset.rowAgent ?? null]
  })

describe('SelectorPanelV2 agent rail', () => {
  it('agentRail="left" puts the agents in a vertical tablist beside the list', () => {
    render(<Panel {...props({ agentRail: 'left' })} />)
    const rail = screen.getByRole('tablist', { name: 'Agents' })
    expect(rail).toHaveAttribute('aria-orientation', 'vertical')
    expect(rail.nextElementSibling).toBe(screen.getByRole('tabpanel'))
    expect(screen.getByRole('tab', { name: 'Cursor' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('tab', { name: 'Claude Agent' })).toHaveAttribute('tabindex', '-1')
  })

  it.each([
    ['left', 'ArrowDown', 'ArrowUp'],
    ['top', 'ArrowRight', 'ArrowLeft']
  ] as const)('in chat, with agentRail="%s", %s and %s open that agent', (agentRail, next, prev) => {
    render(<Panel {...props({ agentRail, source: source({ selectAgent: null }) })} />)
    const cursor = screen.getByRole('tab', { name: 'Cursor' })
    const claude = screen.getByRole('tab', { name: 'Claude Agent' })
    cursor.focus()
    fireEvent.keyDown(cursor, { key: next })
    expect(claude).toHaveFocus()
    expect(claude).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel', { name: 'Claude Agent' })).toBeInTheDocument()
    fireEvent.keyDown(claude, { key: prev })
    expect(cursor).toHaveFocus()
    expect(cursor).toHaveAttribute('aria-selected', 'true')
  })

  it.each([
    ['left', 'ArrowDown'],
    ['top', 'ArrowRight']
  ] as const)('in the launcher, with agentRail="%s", %s only moves focus; a click picks the agent', (agentRail, next) => {
    const selectAgent = vi.fn()
    render(<Panel {...props({ agentRail, source: source({ selectAgent }) })} />)
    const cursor = screen.getByRole('tab', { name: 'Cursor' })
    const claude = screen.getByRole('tab', { name: 'Claude Agent' })
    cursor.focus()
    fireEvent.keyDown(cursor, { key: next })
    expect(claude).toHaveFocus()
    expect(cursor).toHaveAttribute('aria-selected', 'true')
    expect(selectAgent).not.toHaveBeenCalled()
    fireEvent.click(claude)
    expect(selectAgent).toHaveBeenCalledWith(expect.objectContaining({ configId: CLAUDE.id }))
  })

  it('tab icons keep their colour; inactive tabs dim by opacity only', () => {
    render(<Panel {...props({ agentRail: 'left' })} />)
    const wrap = (name: string): HTMLElement | null =>
      screen.getByRole('tab', { name }).querySelector<HTMLElement>('[data-tab-glyph]')
    const active = wrap('Cursor')
    const inactive = wrap('Claude Agent')
    expect(active).toHaveClass('opacity-100')
    expect(inactive).toHaveClass('opacity-55', 'group-hover/tab:opacity-80')
    for (const el of [active, inactive]) {
      expect(el).toHaveClass('transition-opacity', 'duration-150', 'ease-out')
      expect(el).toHaveClass('motion-reduce:transition-none')
    }
    const tab = screen.getByRole('tab', { name: 'Claude Agent' })
    expect(tab).not.toHaveClass('text-muted-foreground')
    // Claude's brand colour survives the inactive state.
    const glyph = inactive?.querySelector<HTMLElement>('[data-agent-brand]')
    expect(glyph?.style.getPropertyValue('--agent-brand-dark')).toBe('#D97757')
    // Cursor's mark is monochrome: it takes the tab's foreground.
    expect(active?.querySelector('[data-agent-brand]')).toBeNull()
  })

  it('the default top strip stays horizontal', () => {
    render(<Panel {...props()} />)
    expect(screen.getByRole('tablist', { name: 'Agents' })).toHaveAttribute(
      'aria-orientation',
      'horizontal'
    )
  })
})

describe('SelectorPanelV2 agent order and overflow', () => {
  const tabNames = (): string[] =>
    within(screen.getByRole('tablist', { name: 'Agents' }))
      .getAllByRole('tab')
      .map((t) => t.getAttribute('aria-label') ?? '')
  const notInstalled = (c: StoredAgentConfig): SupportedAcpAgentEntry => ({
    ...entry(c),
    config: null,
    status: 'install-required'
  })
  // 9 installed + 3 to install: more than the rail's 10 slots.
  const INSTALLED = [
    'Zed Agent',
    'amp',
    'Codex',
    'Gemini',
    'Qwen Code',
    'Goose',
    'Kimi',
    'Auggie',
    'Droid'
  ].map((name) => config(name.toLowerCase().replace(/\s/g, '-'), name))
  const TO_INSTALL = ['OpenCode', 'Aider', 'Crush'].map((name) => config(name.toLowerCase(), name))
  const many = (over: Partial<SelectorSource> = {}): SelectorSource =>
    source({
      selectAgent: null,
      agentConfigs: [CURSOR, CLAUDE, ...INSTALLED],
      entries: [
        ...TO_INSTALL.map(notInstalled),
        entry(CURSOR),
        ...INSTALLED.map(entry),
        entry(CLAUDE)
      ],
      ...over
    })

  it('orders V2 tabs installed first, A to Z, regardless of the current agent', () => {
    render(<Panel {...props()} />)
    expect(tabNames()).toEqual(['Claude Agent', 'Cursor'])
  })

  it('V1 keeps its order: the current agent first', () => {
    render(
      <TooltipProvider>
        <SelectorPanel {...props()} />
      </TooltipProvider>
    )
    expect(tabNames()[0]).toBe('Cursor')
  })

  it('selecting a tab does not move it', () => {
    render(<Panel {...props({ agentRail: 'left', source: source({ selectAgent: null }) })} />)
    const before = tabNames()
    fireEvent.click(screen.getByRole('tab', { name: 'Cursor' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Agent' }))
    expect(tabNames()).toEqual(before)
    expect(screen.getByRole('tab', { name: 'Claude Agent' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  it('fills the rail to its 10 slots, the last one More, in the same order', () => {
    render(<Panel {...props({ agentRail: 'left', source: many() })} />)
    expect(tabNames()).toEqual([
      'amp',
      'Auggie',
      'Claude Agent',
      'Codex',
      'Cursor',
      'Droid',
      'Gemini',
      'Goose',
      'Kimi',
      'More agents'
    ])
    fireEvent.click(screen.getByRole('tab', { name: 'More agents' }))
    const more = screen.getByRole('tabpanel', { name: 'More agents' })
    const names = ['Qwen Code', 'Zed Agent', 'Aider', 'Crush', 'OpenCode']
    const text = more.textContent ?? ''
    const at = names.map((n) => text.indexOf(n))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  it('renders exactly agentTrackCapacity rail tabs (9 + More), sized by the classes the capacity reads', () => {
    render(<Panel {...props({ agentRail: 'left', source: many() })} />)
    const capacity = agentTrackCapacity({ rail: 'left', touch: false, width: null })
    expect(capacity).toBe(10)
    const rail = screen.getByRole('tablist', { name: 'Agents' })
    const tabs = within(rail).getAllByRole('tab')
    expect(tabs).toHaveLength(capacity)
    expect(tabs.at(-1)).toHaveAccessibleName('More agents')
    // The px behind the capacity are the classes on screen: 288 / 8 / 28.
    expect(AGENT_TRACK).toMatchObject({ listMaxHeight: 288, railPadding: 8, railPitch: 28 })
    expect(rail.className.split(' ')).toContain(AGENT_TRACK_CLASS.railPadding)
    expect(AGENT_TRACK_CLASS.railPadding).toBe('py-1')
    for (const tab of tabs) expect(tab.className.split(' ')).toContain('size-7')
    expect(AGENT_TRACK_CLASS.railTab).toBe('size-7')
    expect(screen.getByTestId('selector-list').className.split(' ')).toContain('max-h-72')
    expect(AGENT_TRACK_CLASS.listMaxHeight).toBe('max-h-72')
  })

  it('shows no More when every agent fits', () => {
    render(<Panel {...props({ agentRail: 'left' })} />)
    expect(screen.queryByRole('tab', { name: 'More agents' })).toBeNull()
  })

  it('marks More active while an agent behind it is open, without reordering', () => {
    render(<Panel {...props({ agentRail: 'left', source: many() })} />)
    const before = tabNames()
    fireEvent.click(screen.getByRole('tab', { name: 'More agents' }))
    const more = screen.getByRole('tabpanel', { name: 'More agents' })
    fireEvent.click(within(more).getAllByRole('button', { name: /Zed Agent/ })[0])
    expect(tabNames()).toEqual(before)
    expect(screen.getByRole('tab', { name: 'More agents' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByRole('tabpanel', { name: 'Zed Agent' })).toBeInTheDocument()
  })

  it('marks More active when the current agent itself sits behind it', () => {
    render(
      <Panel
        {...props({
          agentRail: 'left',
          source: many({ currentConfigId: INSTALLED[0].id }),
          agentConfigId: INSTALLED[0].id
        })}
      />
    )
    expect(tabNames()).not.toContain('Zed Agent')
    expect(screen.getByRole('tab', { name: 'More agents' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })
})

describe('SelectorPanelV2 agent icon on every row', () => {
  it.each([
    'top',
    'left'
  ] as const)('with agentRail="%s", each row shows its own agent, not the open tab', (agentRail) => {
    knownCatalogs.current = new Map([[CLAUDE.id, CLAUDE_CATALOG]])
    render(
      <Panel
        {...props({
          agentRail,
          favoritesStore: storeOf([
            [CLAUDE.id, 'claude-opus'],
            [CURSOR.id, 'sonnet']
          ])
        })}
      />
    )
    expect(screen.getByRole('tab', { name: 'Cursor', selected: true })).toBeInTheDocument()
    expect(rowAgents()).toEqual([
      ['Opus via Claude · Claude Agent', CLAUDE.id],
      ['Claude Sonnet', CURSOR.id],
      ['Claude Opus, thinking High', CURSOR.id],
      ['Claude Sonnet', CURSOR.id]
    ])
  })

  it('search results from several agents each show their own agent', () => {
    knownCatalogs.current = new Map([[CLAUDE.id, CLAUDE_CATALOG]])
    render(<Panel {...props({ agentRail: 'left' })} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models and agents' }), {
      target: { value: 'opus' }
    })
    expect(rowAgents()).toEqual([
      ['Claude Opus, thinking High', CURSOR.id],
      ['Opus via Claude · Claude Agent', CLAUDE.id]
    ])
  })
})

describe('SelectorPanelV2 opening scroll', () => {
  const ROW = 28
  const LIST_HEIGHT = 288 // max-h-72: ten rows plus the list's 4px padding top and bottom

  /**
   * A fake layout: rows stacked 28px apart under the list's 4px top padding,
   * a 288px list, and a `scrollIntoView` that scrolls just enough to bring a
   * row in at the bottom edge, as `block: 'nearest'` does.
   */
  function fakeLayout(): () => void {
    const scrolls = new WeakMap<Element, number>()
    const rowsOf = (el: Element): HTMLElement[] =>
      Array.from(
        el
          .closest('[data-testid="selector-list"]')
          ?.querySelectorAll<HTMLElement>('[data-selector-row]') ?? []
      )
    const top = (el: Element): number => 4 + ROW * rowsOf(el).indexOf(el as HTMLElement)
    const restore = [
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => ROW),
      vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function (this: Element) {
        return scrolls.get(this) ?? 0
      }),
      vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (
        this: Element,
        value: number
      ) {
        scrolls.set(this, value)
      })
    ]
    Element.prototype.scrollIntoView = function (this: Element) {
      const list = this.closest('[data-testid="selector-list"]')
      if (!list) return
      const bottom = top(this) + ROW
      const current = scrolls.get(list) ?? 0
      if (bottom > current + LIST_HEIGHT) scrolls.set(list, bottom - LIST_HEIGHT)
    }
    return () => {
      for (const spy of restore) spy.mockRestore()
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  }

  it('opens on a chosen model below the fold, kept in view, with the top row whole', () => {
    const undo = fakeLayout()
    try {
      const values = Array.from({ length: 16 }, (_, i): [string, string] => [`m${i}`, `Model ${i}`])
      render(
        <Panel
          {...props({
            agentRail: 'left',
            modelOption: select('model', 'Model', 'm13', values),
            modelValue: 'm13'
          })}
        />
      )
      const list = screen.getByTestId('selector-list')
      const chosen = screen.getByRole('button', { name: 'Model 13, thinking High', pressed: true })
      const rows = Array.from(list.querySelectorAll('[data-selector-row]'))
      const chosenTop = 4 + ROW * rows.indexOf(chosen)
      // `nearest` alone would leave the list at 4 + 14 * 28 - 288 = 108: 24px into a row.
      expect(list.scrollTop).toBeGreaterThan(0)
      expect(list.scrollTop % ROW).toBe(0)
      expect(chosenTop).toBeGreaterThanOrEqual(list.scrollTop)
      expect(chosenTop + ROW).toBeLessThanOrEqual(list.scrollTop + LIST_HEIGHT)
    } finally {
      undo()
    }
  })

  it('leaves the list at the top when the chosen model is already in view', () => {
    const undo = fakeLayout()
    try {
      render(<Panel {...props({ agentRail: 'left' })} />)
      expect(screen.getByTestId('selector-list').scrollTop).toBe(0)
    } finally {
      undo()
    }
  })
})
