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
    expect(edits[0]).toHaveAccessibleName('Edit Claude Opus, thinking High')
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
      expect(classes(name)).toEqual(expect.arrayContaining(['min-w-0', 'flex-1', 'truncate']))
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
    // The real name; the level is on Edit.
    expect(row).toHaveAttribute('aria-label', long)
    expect(row).toHaveAccessibleName(long)
    const fav = row.closest<HTMLElement>('[class*="group/fav"]')
    expect(classes(fav)).toContain('min-w-0')
    const star = within(fav as HTMLElement).getByRole('button', { name: 'Add to favorites' })
    expect(star).toBeInTheDocument()
    expect(star).not.toHaveAttribute('hidden')
    // Laid over a slot the row always reserves (shrink-0), so a long name
    // truncates before it instead of pushing it out of the 300px panel.
    expect(classes(star)).toEqual(expect.arrayContaining(['absolute', 'right-7.5', 'w-5']))
    const slot = row.querySelector('[data-row-name] + span[aria-hidden="true"]')
    expect(classes(slot)).toEqual(expect.arrayContaining(['shrink-0', 'w-5']))
    const name = row.querySelector('[data-row-name]')
    expect(classes(name)).toEqual(expect.arrayContaining(['min-w-0', 'truncate']))
    const edit = screen.getByTestId('selector-edit')
    expect(edit).toHaveAccessibleName(`Edit ${long}, thinking High`)
    // The Thinking level on Edit stays whole beside the truncating name.
    const level = edit.querySelector('[data-edit-thinking]')
    expect(level).toHaveTextContent('High')
    expect(classes(level)).toEqual(expect.arrayContaining(['shrink-0', 'whitespace-nowrap']))
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

describe('SelectorPanelV2 row tooltip', () => {
  it('leads with the full model name, and leaves the row and Edit names alone', async () => {
    const long = 'Claude 4.7 Opus Thinking Max with Extended 1M Context Window Preview Build'
    const model = select('model', 'Model', 'opus', [
      ['opus', `  ${long} `],
      ['sonnet', 'Claude Sonnet']
    ])
    render(<Panel {...props({ modelOption: model })} />)
    const row = screen.getByRole('button', { name: long, pressed: true })
    fireEvent.focus(row)
    const tip = await screen.findByRole('tooltip')
    // `role=tooltip` is the hidden copy screen readers get: the name is not repeated.
    expect(tip.textContent).not.toContain(long)
    expect(row).toHaveAccessibleDescription('')
    // The visible tooltip leads with the full name (it holds the blank hidden copy too).
    const visible = document.querySelector('[data-side]') as HTMLElement
    expect(visible.textContent?.split('\n\n')[0].trim()).toBe(long)
    // Every row gets it, not just a truncated one.
    fireEvent.blur(row)
    const sonnet = screen.getByRole('button', { name: 'Claude Sonnet' })
    fireEvent.focus(sonnet)
    await waitFor(() =>
      expect(
        (document.querySelector('[data-side]') as HTMLElement | null)?.textContent?.startsWith(
          'Claude Sonnet'
        )
      ).toBe(true)
    )
    // Visual only: the names stay as they were.
    expect(row).toHaveAttribute('aria-label', long)
    expect(screen.getByTestId('selector-edit')).toHaveAttribute(
      'aria-label',
      `Edit ${long}, thinking High`
    )
  })

  it('the Favorites copy rows lead with the full name too', async () => {
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
    for (const name of ['Claude Opus', 'Claude Sonnet']) {
      const copy = screen
        .getAllByRole('button', { name })
        .find((row) => row.closest('[data-favorite-entry]')) as HTMLElement
      expect(copy).toBeDefined()
      fireEvent.focus(copy)
      await waitFor(() =>
        expect(
          (document.querySelector('[data-side]') as HTMLElement | null)?.textContent
            ?.split('\n\n')[0]
            .trim()
        ).toBe(name)
      )
      expect(copy).toHaveAccessibleDescription('')
      expect(copy).toHaveAttribute('aria-label', name)
      fireEvent.blur(copy)
      await waitFor(() => expect(document.querySelector('[data-side]')).toBeNull())
    }
  })
})

describe('SelectorPanelV2 row tooltip after the Edit flyout', () => {
  /** The visible tooltip box (the Radix content; it holds the hidden copy too). */
  const tipText = (): string | undefined =>
    screen.queryByRole('tooltip')?.parentElement?.textContent?.trim()

  async function editThenEscape(): Promise<HTMLElement> {
    render(<Panel {...props()} />)
    const row = activeRow()
    act(() => row.focus())
    fireEvent.keyDown(row, { key: 'ArrowRight' })
    const flyout = await screen.findByTestId('selector-edit-flyout')
    await waitFor(() =>
      expect(within(flyout).getByRole('menuitemradio', { name: 'High' })).toHaveFocus()
    )
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('selector-edit-flyout')).toBeNull())
    await waitFor(() => expect(row).toHaveFocus())
    expect(screen.queryByRole('tooltip')).toBeNull()
    return row
  }

  it('hovering the row afterwards still opens its tooltip', async () => {
    const row = await editThenEscape()
    fireEvent.pointerMove(row, { pointerType: 'mouse' })
    await waitFor(() => expect(tipText()?.startsWith('Claude Opus')).toBe(true), {
      timeout: 2000
    })
  })

  it("arrowing onto another row afterwards opens that row's tooltip", async () => {
    const row = await editThenEscape()
    fireEvent.keyDown(row, { key: 'ArrowDown' })
    const sonnet = screen.getByRole('button', { name: 'Claude Sonnet' })
    await waitFor(() => expect(sonnet).toHaveFocus())
    await waitFor(() => expect(tipText()?.startsWith('Claude Sonnet')).toBe(true))
  })

  it('Tab away and back to the row opens its tooltip again', async () => {
    const row = await editThenEscape()
    act(() => row.blur())
    act(() => row.focus())
    await waitFor(() => expect(tipText()?.startsWith('Claude Opus')).toBe(true))
  })
})

describe('SelectorPanelV2 row description', () => {
  it('a name-only row has no aria-describedby, even with its tooltip open', async () => {
    render(<Panel {...props()} />)
    const row = screen.getByRole('button', { name: 'Claude Sonnet' })
    expect(row).not.toHaveAttribute('aria-describedby')
    fireEvent.focus(row)
    await screen.findByRole('tooltip')
    expect(row).not.toHaveAttribute('aria-describedby')
    expect(row).toHaveAccessibleDescription('')
  })

  it('a row with a description is described by it while the tooltip is open', async () => {
    const model = {
      ...MODEL,
      options: [
        { value: 'opus', name: 'Claude Opus' },
        { value: 'sonnet', name: 'Claude Sonnet', description: 'Fast and smart' }
      ]
    } as SessionConfigOption
    render(<Panel {...props({ modelOption: model })} />)
    const row = screen.getByRole('button', { name: 'Claude Sonnet' })
    fireEvent.focus(row)
    await screen.findByRole('tooltip')
    expect(row).toHaveAttribute('aria-describedby')
    expect(row).toHaveAccessibleDescription('Fast and smart')
  })
})

describe('SelectorPanelV2 selected-row check', () => {
  const checkOf = (row: HTMLElement): Element | null => row.querySelector('[data-row-check]')

  it('the selected row showing the level on Edit has no check; others keep the slot', () => {
    render(<Panel {...props()} />)
    const row = activeRow()
    expect(screen.getByTestId('selector-edit')).toHaveTextContent('High')
    expect(checkOf(row)).toBeNull()
    const sonnet = screen.getByRole('button', { name: 'Claude Sonnet' })
    expect(checkOf(sonnet)?.getAttribute('class')).toContain('opacity-0')
  })

  it('the Favorites copy of the selected row (no Edit) keeps its visible check', () => {
    render(<Panel {...props({ favoritesStore: storeOf([[CURSOR.id, 'opus']]) })} />)
    const rows = screen.getAllByRole('button', { name: 'Claude Opus', pressed: true })
    const copy = rows.find((row) => row.closest('[data-favorite-entry]')) as HTMLElement
    const listed = rows.find((row) => row !== copy) as HTMLElement
    expect(copy).toBeDefined()
    expect(listed).toBeDefined()
    // The list row shows the level on Edit instead of the check.
    expect(screen.getAllByTestId('selector-edit')).toHaveLength(1)
    expect(checkOf(listed)).toBeNull()
    expect(checkOf(copy)?.getAttribute('class')).toContain('opacity-100')
  })

  it('a selected row without a level on Edit keeps its visible check', () => {
    render(<Panel {...props({ thoughtLevel: null, effortValue: null })} />)
    const row = activeRow()
    expect(
      screen.queryByTestId('selector-edit')?.querySelector('[data-edit-thinking]') ?? null
    ).toBeNull()
    expect(checkOf(row)?.getAttribute('class')).toContain('opacity-100')
  })

  it('the name sits 2px closer to the agent glyph than the row gap', () => {
    render(<Panel {...props()} />)
    for (const name of document.querySelectorAll('[data-row-name]')) {
      expect(classes(name)).toContain('-ml-0.5')
    }
  })
})

describe('SelectorPanelV2 Thinking level on the Edit button', () => {
  const edit = (): HTMLElement => screen.getByTestId('selector-edit')
  /** Edit's visible text, chevron aside (it is an aria-hidden svg). */
  const editText = (): string => edit().textContent ?? ''
  const levels = (): HTMLElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-edit-thinking]'))
  const effortOf = (value: string): SessionConfigOption =>
    select(
      'thought_level',
      'Effort',
      value,
      [
        ['high', 'High'],
        ['xhigh', 'Extra High']
      ],
      'thought_level'
    )

  it('High: Edit shows "High ›", named "Edit <name>, thinking High"', () => {
    render(<Panel {...props()} />)
    expect(editText()).toBe('High')
    expect(edit()).toHaveAttribute('aria-label', 'Edit Claude Opus, thinking High')
    expect(edit()).toHaveAccessibleName('Edit Claude Opus, thinking High')
    expect(edit()).toHaveAttribute('aria-haspopup', 'dialog')
    expect(edit()).toHaveAttribute('aria-expanded', 'false')
    const chevron = edit().querySelector('svg')
    expect(chevron).toHaveAttribute('aria-hidden', 'true')
    expect(chevron).toHaveAttribute('width', '12')
    // The row is named by the model alone; no level on the row itself.
    const row = screen.getByRole('button', { pressed: true })
    expect(row).toHaveAttribute('aria-label', 'Claude Opus')
    expect(row.querySelector('[data-row-thinking]')).toBeNull()
    expect(row.textContent?.trim()).toBe('Claude Opus')
  })

  it('Extra High: Edit shows "Extra High ›" and the full name stays on the row', () => {
    const model = select('model', 'Model', 'opus', [['opus', 'Claude 4.7 Opus Thinking']])
    render(
      <Panel
        {...props({ modelOption: model, thoughtLevel: effortOf('xhigh'), effortValue: 'xhigh' })}
      />
    )
    expect(editText()).toBe('Extra High')
    expect(edit()).toHaveAttribute(
      'aria-label',
      'Edit Claude 4.7 Opus Thinking, thinking Extra High'
    )
    expect(screen.getByRole('button', { pressed: true })).toHaveAttribute(
      'aria-label',
      'Claude 4.7 Opus Thinking'
    )
  })

  it('the level uses the row value token, never shrinks, and Edit keeps its box', () => {
    render(<Panel {...props()} />)
    expect(levels()).toHaveLength(1)
    const [level] = levels()
    expect(classes(level)).toEqual(
      expect.arrayContaining([
        'shrink-0',
        'whitespace-nowrap',
        'tabular-nums',
        'text-xs',
        'text-muted-foreground'
      ])
    )
    expect(classes(edit())).toEqual(
      expect.arrayContaining(['shrink-0', 'rounded-md', 'h-7', 'pl-1.5', 'pr-1'])
    )
  })

  it('drops edge whitespace an agent sends in a model name', () => {
    const model = select('model', 'Model', 'opus', [
      ['opus', '  Claude Opus  '],
      ['sonnet', 'Claude Sonnet']
    ])
    render(<Panel {...props({ modelOption: model })} />)
    const row = screen.getByRole('button', { pressed: true })
    expect(row).toHaveAttribute('aria-label', 'Claude Opus')
    expect(row.querySelector('[data-row-name]')?.textContent).toBe('Claude Opus')
    expect(edit()).toHaveAttribute('aria-label', 'Edit Claude Opus, thinking High')
  })

  it('updates after Thinking changes in the Edit flyout, and reports open', async () => {
    function Live(): React.JSX.Element {
      const [effort, setEffort] = useState('high')
      return <Panel {...props({ effortValue: effort, onEffort: setEffort })} />
    }
    render(<Live />)
    const flyout = await openEdit()
    expect(edit()).toHaveAttribute('aria-expanded', 'true')
    // The popup it announces is the flyout itself: a dialog.
    expect(flyout).toHaveAttribute('role', 'dialog')
    expect(edit()).toHaveAttribute('aria-controls', flyout.id)
    fireEvent.click(within(flyout).getByRole('menuitemradio', { name: 'Low' }))
    await waitFor(() => expect(editText()).toBe('Low'))
    expect(edit()).toHaveAccessibleName('Edit Claude Opus, thinking Low')
  })

  it('no thinking option, or no current value: Edit stays "Edit", label unchanged', () => {
    const { rerender } = render(
      <Panel {...props({ thoughtLevel: null, effortValue: undefined })} />
    )
    expect(levels()).toHaveLength(0)
    expect(editText()).toBe('Edit')
    expect(edit()).toHaveAttribute('aria-label', 'Edit Context for Claude Opus')
    expect(screen.getByRole('button', { pressed: true })).toHaveAttribute(
      'aria-label',
      'Claude Opus'
    )
    // An option with no known value: no guessed default.
    rerender(<Panel {...props({ effortValue: undefined })} />)
    expect(levels()).toHaveLength(0)
    expect(editText()).toBe('Edit')
    expect(edit()).toHaveAttribute('aria-label', 'Edit Thinking and Context for Claude Opus')
  })

  it('non-selected rows carry no level and no Edit', () => {
    render(<Panel {...props()} />)
    const sonnet = screen.getByRole('button', { name: 'Claude Sonnet' })
    expect(sonnet).toHaveAttribute('aria-label', 'Claude Sonnet')
    expect(edit().parentElement).not.toContainElement(sonnet)
    expect(sonnet.textContent?.trim()).toBe('Claude Sonnet')
  })

  it('Favorites: the selected copy is named by the model alone, with no level', () => {
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
    const selected = screen.getAllByRole('button', { name: 'Claude Opus', pressed: true })
    expect(selected).toHaveLength(2)
    for (const row of selected) {
      expect(row).toHaveAttribute('aria-label', 'Claude Opus')
      expect(row.textContent?.trim()).toBe('Claude Opus')
      // `aria-label` names the whole subtree: the star and Edit sit beside
      // the row button, never inside it.
      expect(row.querySelector('button, [role="button"]')).toBeNull()
    }
    const [favoriteRow] = selected
    const entry = favoriteRow?.closest('[data-favorite-entry]') as HTMLElement
    expect(within(entry).getByTestId('selector-favorite').parentElement).toBe(entry)
    for (const button of screen.getAllByTestId('selector-edit')) {
      expect(selected.some((row) => row.contains(button))).toBe(false)
    }
    // One Edit, on the list row; it carries the level.
    expect(screen.getAllByTestId('selector-edit')).toHaveLength(1)
    expect(levels()).toHaveLength(1)
    expect(edit()).toHaveAttribute('aria-label', 'Edit Claude Opus, thinking High')
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
      name: 'Claude Opus',
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

    // Focus handed back by the flyout does not pop the row's tooltip, so the
    // next Escape closes the picker.
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(row).not.toHaveAttribute('data-state', 'delayed-open')
    expect(row).not.toHaveAttribute('data-state', 'instant-open')

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
      b.getAttribute('aria-label')
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
    // Names as read aloud: each row button's aria-label.
    favoriteRows().map(
      (row) => row.querySelector('[data-selector-row]')?.getAttribute('aria-label') ?? ''
    )
  const starOf = (row: HTMLElement): HTMLElement => within(row).getByTestId('selector-favorite')
  const listRow = (name: string): HTMLElement => {
    const rows = Array.from(
      screen.getByTestId('selector-list').querySelectorAll<HTMLElement>('[data-selector-row]')
    ).filter(
      (row) => row.getAttribute('aria-label') === name && !row.closest('[data-favorite-entry]')
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
    expect(listRow('Claude Opus')).toHaveAttribute('aria-pressed', 'true')
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
      'Claude Opus'
    ])
    // First: the next favorite takes focus.
    await act(async () => fireEvent.click(starOf(favoriteRows()[0] as HTMLElement)))
    expect(favoriteNames()).toEqual(['Claude Sonnet', 'Claude Opus'])
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
    // The name as read aloud: the row's aria-label.
    return [row.getAttribute('aria-label') ?? '', slot?.dataset.rowAgent ?? null]
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
      ['Claude Opus', CURSOR.id],
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
      ['Claude Opus', CURSOR.id],
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
      const chosen = screen.getByRole('button', { name: 'Model 13', pressed: true })
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
