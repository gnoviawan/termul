import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { ROW_FOCUS } from './SelectorOptionRows'
import { SelectorPanel } from './SelectorPanel'
import { SelectorPanelV2, type SelectorPanelV2Props } from './SelectorPanelV2'
import {
  AGENT_TRACK,
  AGENT_TRACK_CLASS,
  agentTrackCapacity,
  type ModelCatalog
} from './selector-model'
import type { SelectorSource } from './selector-source'
import {
  PICKER_EDIT_MOTION,
  PICKER_LABEL,
  PICKER_ROW,
  PICKER_ROW_NAME_PULL,
  PICKER_ROW_SELECTED,
  PICKER_ROW_SELECTED_BOX,
  PICKER_STAR_MOTION,
  PICKER_SURFACE
} from './selector-tokens'

// jsdom omits `document.elementFromPoint`; floating-ui calls it.
if (typeof document.elementFromPoint !== 'function') {
  Object.defineProperty(document, 'elementFromPoint', {
    value: () => null,
    configurable: true,
    writable: true
  })
}

const { knownCatalogs, stored, reducedMotion } = vi.hoisted(() => ({
  knownCatalogs: { current: new Map<string, ModelCatalog>() },
  /** The persistence store: rejected option values per agent. */
  stored: new Map<string, unknown>(),
  /** What `useReducedMotion` reports; framer reads the media query once per process. */
  reducedMotion: { current: false }
}))

vi.mock('framer-motion', async (importActual) => {
  const actual = await importActual<typeof import('framer-motion')>()
  return { ...actual, useReducedMotion: () => reducedMotion.current }
})

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
  reducedMotion.current = false
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
    // truncates before it instead of pushing it out of the 300px panel. With
    // the level on Edit (no check) the slot ends the row, flush with Edit.
    expect(classes(star)).toContain('w-5')
    expect(classes(star.parentElement)).toEqual(expect.arrayContaining(['absolute', 'right-0']))
    const slot = row.querySelector('[data-row-name] + span[aria-hidden="true"]')
    expect(classes(slot)).toEqual(expect.arrayContaining(['shrink-0', 'w-5']))
    expect(row.lastElementChild).toBe(slot)
    expect(classes(row)).toContain('pr-0')
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

  it('the Favorites copy of the selected row shows the level on its own Edit, no check', () => {
    render(<Panel {...props({ favoritesStore: storeOf([[CURSOR.id, 'opus']]) })} />)
    const rows = screen.getAllByRole('button', { name: 'Claude Opus', pressed: true })
    const copy = rows.find((row) => row.closest('[data-favorite-entry]')) as HTMLElement
    const listed = rows.find((row) => row !== copy) as HTMLElement
    expect(copy).toBeDefined()
    expect(listed).toBeDefined()
    // Both copies of the active model carry Edit with the level, in place of the check.
    const edits = screen.getAllByTestId('selector-edit')
    expect(edits).toHaveLength(2)
    for (const row of [copy, listed]) {
      expect(checkOf(row)).toBeNull()
      expect(edits.some((edit) => edit.parentElement?.contains(row))).toBe(true)
    }
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
      expect(classes(name)).toContain(PICKER_ROW_NAME_PULL)
    }
  })
})

describe('SelectorPanelV2 selected-row fill', () => {
  const THREE = select('model', 'Model', 'opus', [
    ['opus', 'Claude Opus'],
    ['sonnet', 'Claude Sonnet'],
    ['haiku', 'Claude Haiku']
  ])
  /** Boxes marked as the selected row. */
  const marked = (): HTMLElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-row-selected]'))
  /** Everything in the list carrying the selected fill (SVGs included, so read the attribute). */
  const filled = (): HTMLElement[] =>
    Array.from(screen.getByTestId('selector-list').querySelectorAll<HTMLElement>('*')).filter(
      (el) => (el.getAttribute('class') ?? '').split(/\s+/).includes(PICKER_ROW_SELECTED)
    )
  /** The marked box around a row button, if any. */
  const boxOf = (row: HTMLElement): HTMLElement | null =>
    row.closest<HTMLElement>('[data-row-selected]')
  const rowsNamed = (name: string): HTMLElement[] =>
    screen.getAllByRole('button', { name }).filter((el) => el.hasAttribute('data-selector-row'))

  function PickPanel(p: SelectorPanelV2Props): React.JSX.Element {
    const [model, setModel] = useState(p.modelValue)
    return (
      <Panel
        {...p}
        modelValue={model}
        onPickModel={(value) => {
          p.onPickModel(value)
          setModel(value)
        }}
      />
    )
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('is the rail active fill, held under hover', () => {
    expect(PICKER_ROW_SELECTED).toBe('bg-foreground/10')
    expect(PICKER_ROW_SELECTED_BOX.split(' ')).toEqual([
      PICKER_ROW_SELECTED,
      `hover:${PICKER_ROW_SELECTED}`
    ])
  })

  it('fills the whole outer box of the list row and its Favorites copy, and no other row', () => {
    render(
      <Panel
        {...props({
          modelOption: THREE,
          favoritesStore: storeOf([
            [CURSOR.id, 'opus'],
            [CURSOR.id, 'sonnet']
          ])
        })}
      />
    )
    const opus = rowsNamed('Claude Opus')
    expect(opus).toHaveLength(2)
    const boxes = marked()
    expect(boxes).toHaveLength(2)
    expect(filled()).toEqual(boxes)
    for (const row of opus) {
      const box = boxOf(row) as HTMLElement
      expect(boxes).toContain(box)
      expect(box).toHaveAttribute('data-row-selected', '')
      expect(classes(box)).toContain(PICKER_ROW_SELECTED)
      expect(classes(box)).toContain(PICKER_ROW.radius)
      // The outermost box: glyph, name, star and Edit all sit inside it.
      expect(box.querySelector('[data-row-agent]')).not.toBeNull()
      expect(box.querySelector('[data-row-name]')).not.toBeNull()
      expect(box.querySelector('[data-testid="selector-favorite"]')).not.toBeNull()
      expect(box.querySelector('[data-testid="selector-edit"]')).not.toBeNull()
      expect(box.parentElement?.closest('[data-row-selected]')).toBeNull()
      // Full-contrast name.
      expect(classes(row)).toContain('text-foreground')
    }
    for (const name of ['Claude Sonnet', 'Claude Haiku']) {
      for (const row of rowsNamed(name)) expect(boxOf(row)).toBeNull()
    }
  })

  it('a selected row without Edit fills the box around its star and check', () => {
    render(
      <Panel
        {...props({
          thoughtLevel: null,
          effortValue: null,
          genericOptions: [],
          favoritesStore: storeOf([[CURSOR.id, 'opus']])
        })}
      />
    )
    expect(screen.queryByTestId('selector-edit')).toBeNull()
    const boxes = marked()
    expect(boxes).toHaveLength(2)
    expect(filled()).toEqual(boxes)
    for (const row of rowsNamed('Claude Opus')) {
      const box = boxOf(row) as HTMLElement
      expect(boxes).toContain(box)
      expect(box.querySelector('[data-row-check]')).not.toBeNull()
      expect(box.querySelector('[data-testid="selector-favorite"]')).not.toBeNull()
    }
  })

  it('hover and the open flyout never replace the fill; other rows hover at 3%', async () => {
    render(<Panel {...props({ favoritesStore: storeOf([[CURSOR.id, 'opus']]) })} />)
    const check = (): void => {
      for (const box of marked()) {
        const names = classes(box)
        expect(names).toContain(PICKER_ROW_SELECTED)
        expect(names).toContain(`hover:${PICKER_ROW_SELECTED}`)
        expect(names).not.toContain('bg-row-hover')
        expect(names).not.toContain('hover:bg-row-hover')
      }
    }
    check()
    const [edit] = screen.getAllByTestId('selector-edit') as [HTMLElement]
    fireEvent.click(edit)
    await screen.findByTestId('selector-edit-flyout')
    expect(edit).toHaveAttribute('aria-expanded', 'true')
    check()
    // An unselected row keeps the plain 3% hover and no fill.
    const sonnet = rowsNamed('Claude Sonnet')[0] as HTMLElement
    const box = sonnet.closest('.group\\/fav') as HTMLElement
    expect(classes(box)).toContain('hover:bg-row-hover')
    expect(classes(box)).not.toContain(PICKER_ROW_SELECTED)
  })

  it('moves on a pick: the old row loses it at once, even while its Edit copy leaves', () => {
    vi.useFakeTimers()
    render(
      <PickPanel
        {...props({
          modelOption: THREE,
          favoritesStore: storeOf([
            [CURSOR.id, 'opus'],
            [CURSOR.id, 'sonnet']
          ])
        })}
      />
    )
    const sonnet = rowsNamed('Claude Sonnet').at(-1) as HTMLElement
    fireEvent.click(sonnet)
    // The old Edits are still fading out beside the old rows.
    const leaving = Array.from(document.querySelectorAll<HTMLElement>('[data-edit-exiting]'))
    expect(leaving).toHaveLength(2)
    for (const copy of leaving) {
      const box = copy.parentElement as HTMLElement
      expect(box.closest('[data-row-selected]')).toBeNull()
      expect(classes(box)).not.toContain(PICKER_ROW_SELECTED)
    }
    for (const row of rowsNamed('Claude Opus')) expect(boxOf(row)).toBeNull()
    const boxes = marked()
    expect(boxes).toHaveLength(2)
    expect(filled()).toEqual(boxes)
    for (const row of rowsNamed('Claude Sonnet')) expect(boxes).toContain(boxOf(row))

    act(() => {
      vi.advanceTimersByTime(PICKER_EDIT_MOTION.exitMs)
    })
    expect(document.querySelector('[data-edit-exiting]')).toBeNull()
    expect(marked()).toEqual(boxes)
    expect(filled()).toEqual(boxes)
  })

  it('reads selected from aria-pressed: selected, hover and keyboard-focus rows carry distinct tokens', () => {
    render(
      <Panel {...props({ modelOption: THREE, favoritesStore: storeOf([[CURSOR.id, 'opus']]) })} />
    )
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-selector-row]'))
    const pressed = rows.filter((row) => row.getAttribute('aria-pressed') === 'true')
    expect(pressed.map((row) => row.getAttribute('aria-label'))).toEqual([
      'Claude Opus',
      'Claude Opus'
    ])
    // Exactly the aria-pressed rows sit in a filled box.
    for (const row of rows) expect(boxOf(row) !== null).toBe(pressed.includes(row))
    // Hover (unselected): the 3% wash, never the fill.
    const plain = rowsNamed('Claude Haiku')[0] as HTMLElement
    const plainBox = plain.closest('.group\\/fav') ?? plain
    expect(classes(plainBox as HTMLElement)).toContain('hover:bg-row-hover')
    expect(classes(plainBox as HTMLElement)).not.toContain(PICKER_ROW_SELECTED)
    // Keyboard focus: the focus ring only, no fill, on selected and plain rows alike.
    for (const row of [plain, ...pressed]) {
      for (const token of ROW_FOCUS.split(' ')) expect(classes(row)).toContain(token)
      expect(classes(row)).not.toContain(PICKER_ROW_SELECTED)
    }
    plain.focus()
    expect(plain).toHaveFocus()
    expect(boxOf(plain)).toBeNull()
  })

  it('the exiting Edit copy never carries the selected token', () => {
    vi.useFakeTimers()
    render(<PickPanel {...props({ modelOption: THREE })} />)
    fireEvent.click(rowsNamed('Claude Sonnet')[0] as HTMLElement)
    const copy = document.querySelector<HTMLElement>('[data-edit-exiting]') as HTMLElement
    expect(copy).not.toBeNull()
    expect(copy.closest('[data-row-selected]')).toBeNull()
    for (const el of [copy, ...Array.from(copy.querySelectorAll<HTMLElement>('*'))]) {
      expect((el.getAttribute('class') ?? '').split(/\s+/)).not.toContain(PICKER_ROW_SELECTED)
    }
  })

  it('Edit on the selected fill uses secondary ink, not muted (muted drops under 4.5:1)', () => {
    render(<Panel {...props({ modelOption: THREE })} />)
    const edits = screen.getAllByTestId('selector-edit')
    expect(edits.length).toBeGreaterThan(0)
    for (const edit of edits) {
      expect(edit.closest('[data-row-selected]')).not.toBeNull()
      // Edit and its Thinking level, which sets its own ink.
      const inked = [
        edit,
        ...Array.from(edit.querySelectorAll<HTMLElement>('[data-edit-thinking]'))
      ]
      for (const el of inked) {
        const ink = (el.getAttribute('class') ?? '').split(/\s+/)
        expect(ink).toContain('text-secondary-foreground')
        expect(ink).not.toContain('text-muted-foreground')
      }
    }
  })

  it('the rail active tab uses the same fill', () => {
    render(<Panel {...props({ agentRail: 'left' })} />)
    const indicator = screen
      .getByRole('tab', { name: 'Cursor' })
      .querySelector<HTMLElement>(':scope > span[aria-hidden="true"]')
    expect(classes(indicator)).toContain(PICKER_ROW_SELECTED)
    const inactive = screen.getByRole('tab', { name: 'Claude Agent' })
    expect(inactive.querySelector(':scope > span[aria-hidden="true"]')).toBeNull()
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
        // The level sits on the selected fill, where muted ink falls under 4.5:1.
        'text-secondary-foreground'
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
    // The star's positioned box is the row button's sibling in the entry.
    expect(
      within(entry).getByTestId('selector-favorite').closest('[data-star-box]')?.parentElement
    ).toBe(entry)
    for (const button of screen.getAllByTestId('selector-edit')) {
      expect(selected.some((row) => row.contains(button))).toBe(false)
    }
    // Two Edits, one per copy of the active model; each carries the level.
    // The copy's (first, in Favorites) says where it is; the list row's does not.
    const edits = screen.getAllByTestId('selector-edit')
    expect(edits).toHaveLength(2)
    expect(levels().map((level) => level.textContent)).toEqual(['High', 'High'])
    expect(edits.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Edit Claude Opus in Favorites, thinking High',
      'Edit Claude Opus, thinking High'
    ])
    // The Favorites group tells them apart: only the copy's Edit is inside it.
    const group = screen.getByRole('group', { name: 'Favorites' })
    expect(edits.filter((button) => group.contains(button))).toHaveLength(1)
    expect(group).toContainElement(favoriteRow as HTMLElement)
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

describe('SelectorPanelV2 Edit on the Favorites copy', () => {
  const favoritesOf = (): HTMLElement => screen.getByRole('group', { name: 'Favorites' })
  /** The active model's row: its Favorites copy or its list row. */
  const copyRow = (): HTMLElement =>
    within(favoritesOf()).getByRole('button', { name: 'Claude Opus', pressed: true })
  const listedRow = (): HTMLElement =>
    screen
      .getAllByRole('button', { name: 'Claude Opus', pressed: true })
      .find((row) => !favoritesOf().contains(row)) as HTMLElement
  /** The Edit button beside a row. */
  const editOf = (row: HTMLElement): HTMLElement => editBeside(row) as HTMLElement
  const levelTexts = (): string[] =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-edit-thinking]')).map(
      (level) => level.textContent ?? ''
    )

  /** The panel with live effort state, as the composer holds it. */
  function LivePanel(p: SelectorPanelV2Props): React.JSX.Element {
    const [effort, setEffort] = useState(p.effortValue)
    return (
      <Panel
        {...p}
        effortValue={effort}
        thoughtLevel={p.thoughtLevel ? { ...p.thoughtLevel, currentValue: effort ?? '' } : null}
        onEffort={(value) => {
          p.onEffort(value)
          setEffort(value)
        }}
      />
    )
  }

  it('Edit on the copy opens the flyout; a Thinking pick updates both levels', async () => {
    const onEffort = vi.fn()
    render(<LivePanel {...props({ onEffort, favoritesStore: storeOf([[CURSOR.id, 'opus']]) })} />)
    expect(levelTexts()).toEqual(['High', 'High'])
    const edit = editOf(copyRow())
    expect(favoritesOf()).toContainElement(edit)
    fireEvent.click(edit)
    const flyout = await screen.findByTestId('selector-edit-flyout')
    expect(edit).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(within(flyout).getByRole('menuitemradio', { name: 'Medium' }))
    expect(onEffort).toHaveBeenCalledWith('medium')
    await waitFor(() => expect(levelTexts()).toEqual(['Medium', 'Medium']))
  })

  it('the copy\'s Edit has its own name, "in Favorites", with the visible level last', () => {
    render(<Panel {...props({ favoritesStore: storeOf([[CURSOR.id, 'opus']]) })} />)
    const copyEdit = editOf(copyRow())
    const listedEdit = editOf(listedRow())
    const copyName = copyEdit.getAttribute('aria-label') ?? ''
    const listedName = listedEdit.getAttribute('aria-label') ?? ''
    expect(copyName).not.toBe(listedName)
    expect(copyName).toContain('in Favorites')
    expect(copyEdit).toHaveAccessibleName('Edit Claude Opus in Favorites, thinking High')
    expect(listedEdit).toHaveAccessibleName('Edit Claude Opus, thinking High')
    // Label in name: each name ends with the text its button shows.
    for (const button of [copyEdit, listedEdit]) {
      const shown = button.textContent?.trim() ?? ''
      expect(shown).toBe('High')
      expect(button.getAttribute('aria-label')?.endsWith(shown)).toBe(true)
    }
  })

  it("with no level, the copy's Edit still names Favorites, as the fallback does", () => {
    render(
      <Panel {...props({ thoughtLevel: null, favoritesStore: storeOf([[CURSOR.id, 'opus']]) })} />
    )
    expect(editOf(copyRow())).toHaveAccessibleName('Edit Context for Claude Opus in Favorites')
    expect(editOf(listedRow())).toHaveAccessibleName('Edit Context for Claude Opus')
  })

  it("only one flyout is open: Edit on the list row closes the copy's", async () => {
    render(<Panel {...props({ favoritesStore: storeOf([[CURSOR.id, 'opus']]) })} />)
    const copyEdit = editOf(copyRow())
    const listedEdit = editOf(listedRow())
    expect(copyEdit).not.toBe(listedEdit)
    fireEvent.click(copyEdit)
    await screen.findByTestId('selector-edit-flyout')
    expect(copyEdit).toHaveAttribute('aria-expanded', 'true')
    // A press outside the open flyout dismisses it, then the click opens the other.
    fireEvent.pointerDown(listedEdit)
    fireEvent.click(listedEdit)
    await waitFor(() => expect(copyEdit).toHaveAttribute('aria-expanded', 'false'))
    expect(listedEdit).toHaveAttribute('aria-expanded', 'true')
    await waitFor(() => expect(screen.getAllByTestId('selector-edit-flyout')).toHaveLength(1))
  })

  it('ArrowRight on the copy opens it; ArrowLeft returns focus to the copy', async () => {
    render(<Panel {...props({ favoritesStore: storeOf([[CURSOR.id, 'opus']]) })} />)
    const copy = copyRow()
    act(() => copy.focus())
    fireEvent.keyDown(copy, { key: 'ArrowRight' })
    const flyout = await screen.findByTestId('selector-edit-flyout')
    await waitFor(() =>
      expect(within(flyout).getByRole('menuitemradio', { name: 'High' })).toHaveFocus()
    )
    expect(editOf(copy)).toHaveAttribute('aria-expanded', 'true')
    expect(editOf(listedRow())).toHaveAttribute('aria-expanded', 'false')
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' })
    await waitFor(() => expect(screen.queryByTestId('selector-edit-flyout')).toBeNull())
    await waitFor(() => expect(copy).toHaveFocus())
  })

  it("Escape from the copy's flyout returns to the copy, quietly; the next closes the picker", async () => {
    const onOpenChange = vi.fn()
    render(
      <InPicker
        {...props({ favoritesStore: storeOf([[CURSOR.id, 'opus']]) })}
        onOpenChange={onOpenChange}
      />
    )
    const copy = await waitFor(copyRow)
    act(() => copy.focus())
    fireEvent.keyDown(copy, { key: 'ArrowRight' })
    const flyout = await screen.findByTestId('selector-edit-flyout')
    await waitFor(() =>
      expect(within(flyout).getByRole('menuitemradio', { name: 'High' })).toHaveFocus()
    )
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('selector-edit-flyout')).toBeNull())
    expect(onOpenChange).not.toHaveBeenCalled()
    await waitFor(() => expect(copy).toHaveFocus())
    expect(listedRow()).not.toHaveFocus()
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(copy).not.toHaveAttribute('data-state', 'delayed-open')
    expect(copy).not.toHaveAttribute('data-state', 'instant-open')
    fireEvent.keyDown(copy, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("unselected favorites and other agents' favorites get no Edit", () => {
    knownCatalogs.current = new Map([
      [CLAUDE.id, { ...CLAUDE_CATALOG, currentValue: 'claude-opus' } as ModelCatalog]
    ])
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
    const entries = Array.from(favoritesOf().querySelectorAll<HTMLElement>('[data-favorite-entry]'))
    expect(entries).toHaveLength(3)
    const named = entries
      .filter((entry) => editBeside(entry) !== undefined)
      .map((entry) => entry.querySelector('[data-selector-row]')?.getAttribute('aria-label'))
    expect(named).toEqual(['Claude Opus'])
    expect(
      within(favoritesOf()).queryByRole('button', { name: /^Edit Opus via Claude/ })
    ).toBeNull()
    arrowRightOpensNothing(within(favoritesOf()).getByRole('button', { name: 'Claude Sonnet' }))
    arrowRightOpensNothing(
      within(favoritesOf()).getByRole('button', { name: 'Opus via Claude · Claude Agent' })
    )
  })

  it('unstarring the selected copy moves focus to the next favorite, else the previous', async () => {
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
    const starOfCopy = (): HTMLElement =>
      within(copyRow().closest('[data-favorite-entry]') as HTMLElement).getByTestId(
        'selector-favorite'
      )
    await act(async () => fireEvent.click(starOfCopy()))
    expect(
      within(favoritesOf()).queryByRole('button', { name: 'Claude Opus', pressed: true })
    ).toBeNull()
    expect(within(favoritesOf()).getByRole('button', { name: 'Claude Sonnet' })).toHaveFocus()
    // Only the list row's Edit is left.
    expect(screen.getAllByTestId('selector-edit')).toHaveLength(1)
    cleanup()

    render(
      <Panel
        {...props({
          favoritesStore: storeOf([
            [CURSOR.id, 'sonnet'],
            [CURSOR.id, 'opus']
          ])
        })}
      />
    )
    await act(async () => fireEvent.click(starOfCopy()))
    expect(within(favoritesOf()).getByRole('button', { name: 'Claude Sonnet' })).toHaveFocus()
  })
})

describe('SelectorPanelV2 Edit motion on a pick', () => {
  const THREE = select('model', 'Model', 'opus', [
    ['opus', 'Claude Opus'],
    ['sonnet', 'Claude Sonnet'],
    ['haiku', 'Claude Haiku']
  ])
  const favoritesOf = (): HTMLElement => screen.getByRole('group', { name: 'Favorites' })
  /** A model's row in the list (not its Favorites copy). */
  const listed = (name: string): HTMLElement => {
    const group = screen.queryByRole('group', { name: 'Favorites' })
    return screen
      .getAllByRole('button', { name })
      .find((row) => !group?.contains(row)) as HTMLElement
  }
  /** Edit buttons a screen reader can reach. */
  const editButtons = (): HTMLElement[] => screen.queryAllByRole('button', { name: /^Edit / })
  /** Edits on their way out: inert copies left beside the old row. */
  const exiting = (): HTMLElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-edit-exiting]'))
  const pressed = (): string[] =>
    screen
      .getAllByRole('button', { pressed: true })
      // Rows only: a starred row's star is pressed too.
      .filter((row) => row.hasAttribute('data-selector-row'))
      .map((row) => row.getAttribute('aria-label') ?? '')
  const settle = (): void => {
    act(() => {
      vi.advanceTimersByTime(PICKER_EDIT_MOTION.exitMs)
    })
  }

  /** The panel holding the picked model, as the composer does. */
  function PickPanel(p: SelectorPanelV2Props): React.JSX.Element {
    const [model, setModel] = useState(p.modelValue)
    return (
      <Panel
        {...p}
        modelValue={model}
        onPickModel={(value) => {
          p.onPickModel(value)
          setModel(value)
        }}
      />
    )
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it("on open, the selected rows' Edits are at rest: no entrance, nothing leaving", () => {
    render(<PickPanel {...props({ favoritesStore: storeOf([[CURSOR.id, 'opus']]) })} />)
    const edits = screen.getAllByTestId('selector-edit')
    expect(edits).toHaveLength(2)
    for (const edit of edits) {
      expect(edit).not.toHaveAttribute('data-entering')
      expect(classes(edit).some((name) => name.startsWith('starting:'))).toBe(false)
    }
    expect(exiting()).toHaveLength(0)
  })

  it('arrow keys move focus only: no Edit enters or leaves', () => {
    render(<PickPanel {...props({ modelOption: THREE })} />)
    const opus = activeRow()
    act(() => opus.focus())
    fireEvent.keyDown(opus, { key: 'ArrowDown' })
    expect(listed('Claude Sonnet')).toHaveFocus()
    expect(pressed()).toEqual(['Claude Opus'])
    expect(screen.getByTestId('selector-edit')).not.toHaveAttribute('data-entering')
    expect(exiting()).toHaveLength(0)
  })

  it("the picked row's Edit enters; the old one leaves inert and hidden, then unmounts", () => {
    vi.useFakeTimers()
    const onPickModel = vi.fn()
    render(
      <PickPanel
        {...props({
          onPickModel,
          favoritesStore: storeOf([
            [CURSOR.id, 'opus'],
            [CURSOR.id, 'sonnet']
          ])
        })}
      />
    )
    expect(editButtons()).toHaveLength(2)
    fireEvent.click(listed('Claude Sonnet'))
    expect(onPickModel).toHaveBeenCalledWith('sonnet')

    // The new list row and its Favorites copy: the only Edits in the a11y tree.
    expect(editButtons().map((edit) => edit.getAttribute('aria-label'))).toEqual([
      'Edit Claude Sonnet in Favorites, thinking High',
      'Edit Claude Sonnet, thinking High'
    ])
    for (const edit of editButtons()) expect(edit).toHaveAttribute('data-entering')
    expect(within(favoritesOf()).getAllByRole('button', { name: /^Edit / })).toHaveLength(1)

    // From the first render of the exit: inert, hidden, unreachable.
    const old = exiting()
    expect(old).toHaveLength(2)
    for (const edit of old) {
      expect(edit).toHaveAttribute('inert')
      expect(edit).toHaveAttribute('aria-hidden', 'true')
      expect(edit).toHaveTextContent('High')
      act(() => edit.focus())
      expect(document.activeElement).not.toBe(edit)
      fireEvent.click(edit)
    }
    expect(screen.queryByTestId('selector-edit-flyout')).toBeNull()
    expect(onPickModel).toHaveBeenCalledTimes(1)

    // The old rows are the plain unselected row, check slot and all.
    for (const row of screen.getAllByRole('button', { name: 'Claude Opus' })) {
      expect(row).toHaveAttribute('aria-pressed', 'false')
      expect(row.querySelector('[data-row-check]')?.getAttribute('class')).toContain('opacity-0')
    }
    expect(pressed()).toEqual(['Claude Sonnet', 'Claude Sonnet'])

    settle()
    expect(exiting()).toHaveLength(0)
    for (const edit of old) expect(edit).not.toBeInTheDocument()
    expect(editButtons()).toHaveLength(2)
  })

  it('quick picks mid-animation end on the last pick, with nothing left leaving', () => {
    vi.useFakeTimers()
    render(
      <PickPanel
        {...props({ modelOption: THREE, favoritesStore: storeOf([[CURSOR.id, 'haiku']]) })}
      />
    )
    fireEvent.click(listed('Claude Sonnet'))
    act(() => {
      vi.advanceTimersByTime(50)
    })
    fireEvent.click(listed('Claude Haiku'))
    // Opus is still leaving; Sonnet's Edit, cut off mid-entrance, leaves too.
    expect(exiting()).toHaveLength(2)
    expect(pressed()).toEqual(['Claude Haiku', 'Claude Haiku'])
    expect(editButtons().map((edit) => edit.getAttribute('aria-label'))).toEqual([
      'Edit Claude Haiku in Favorites, thinking High',
      'Edit Claude Haiku, thinking High'
    ])

    settle()
    expect(exiting()).toHaveLength(0)
    expect(pressed()).toEqual(['Claude Haiku', 'Claude Haiku'])
    expect(editButtons()).toHaveLength(2)
  })

  it('picking the old row back mid-exit gives it the real Edit and drops its copy', () => {
    vi.useFakeTimers()
    render(<PickPanel {...props({ modelOption: THREE })} />)
    fireEvent.click(listed('Claude Sonnet'))
    act(() => {
      vi.advanceTimersByTime(50)
    })
    fireEvent.click(listed('Claude Opus'))
    expect(pressed()).toEqual(['Claude Opus'])
    const opusEdit = editBeside(activeRow()) as HTMLElement
    expect(opusEdit).toHaveAccessibleName('Edit Claude Opus, thinking High')
    // Only Sonnet's copy is leaving; none sits beside Opus.
    expect(exiting()).toHaveLength(1)
    expect(opusEdit.parentElement?.querySelector('[data-edit-exiting]')).toBeNull()
    // The leaving copy sits in the old row's box, beside the row (and its star).
    expect(exiting()[0]?.parentElement).toContainElement(listed('Claude Sonnet'))

    settle()
    expect(exiting()).toHaveLength(0)
    expect(editButtons()).toEqual([opusEdit])
  })

  it('unmounting mid-exit leaves no timer behind', () => {
    vi.useFakeTimers()
    const { unmount } = render(<PickPanel {...props()} />)
    const before = vi.getTimerCount()
    fireEvent.click(listed('Claude Sonnet'))
    expect(exiting()).toHaveLength(1)
    expect(vi.getTimerCount()).toBeGreaterThan(before)
    unmount()
    expect(vi.getTimerCount()).toBe(before)
  })

  it('reduced motion: no entrance, and the old Edit goes at once', () => {
    reducedMotion.current = true
    render(
      <PickPanel
        {...props({
          favoritesStore: storeOf([
            [CURSOR.id, 'opus'],
            [CURSOR.id, 'sonnet']
          ])
        })}
      />
    )
    fireEvent.click(listed('Claude Sonnet'))
    expect(exiting()).toHaveLength(0)
    expect(editButtons()).toHaveLength(2)
    for (const edit of editButtons()) {
      expect(edit).not.toHaveAttribute('data-entering')
      expect(classes(edit).some((name) => name.startsWith('starting:'))).toBe(false)
    }
  })

  describe('the star', () => {
    /**
     * A fake layout for star boxes (jsdom has none): a 300px row, a 20px star,
     * the check's 30px right of it, Edit (or its leaving copy) 20px plus 6px a
     * character, and the box's own inline translate, as a real rect has.
     */
    const original = HTMLElement.prototype.getBoundingClientRect
    function starLeft(box: HTMLElement): number {
      const beside = box.parentElement?.nextElementSibling
      const edit = beside?.matches('[data-testid="selector-edit"], [data-edit-exiting]')
        ? 20 + 6 * (beside.textContent?.length ?? 0)
        : 0
      const check = box.classList.contains('right-0') ? 0 : 30
      const shift = Number(/translateX\((-?[\d.]+)px\)/.exec(box.style.transform)?.[1] ?? 0)
      return 300 - edit - check - 20 + shift
    }
    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement
      ) {
        if (!this.hasAttribute('data-star-box')) return original.call(this)
        const left = starLeft(this)
        return {
          left,
          x: left,
          right: left + 20,
          top: 0,
          y: 0,
          bottom: 28,
          width: 20,
          height: 28,
          toJSON: () => ({})
        } as DOMRect
      })
    })
    afterEach(() => {
      vi.restoreAllMocks()
    })

    /** Every inline style a star box has had, oldest first, ending with its current one. */
    function watchStars(): (box: Element) => string[] {
      const seen = new Map<Element, string[]>()
      const take = (records: MutationRecord[]): void => {
        for (const record of records) {
          const box = record.target as Element
          if (!box.hasAttribute('data-star-box')) continue
          seen.set(box, [...(seen.get(box) ?? []), record.oldValue ?? ''])
        }
      }
      const observer = new MutationObserver(take)
      observer.observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ['style'],
        attributeOldValue: true
      })
      return (box) => {
        take(observer.takeRecords())
        return [...(seen.get(box) ?? []), box.getAttribute('style') ?? '']
      }
    }
    const starBoxes = (name?: string): HTMLElement[] =>
      name === undefined
        ? Array.from(document.querySelectorAll<HTMLElement>('[data-star-box]'))
        : screen
            .getAllByRole('button', { name })
            .map((row) => row.parentElement?.querySelector<HTMLElement>('[data-star-box]'))
            .filter((box): box is HTMLElement => box != null)
    const atRest = (box: HTMLElement): void => {
      expect(box.style.transform).toBe('')
      expect(box.style.transition).toBe('')
    }
    /** A style that puts the star `px` off its place with no transition: a FLIP's first frame. */
    const heldAt =
      (px: number) =>
      (style: string): boolean =>
        style.includes(`translateX(${px}px)`) && style.includes('transition: none')
    const BOTH: Array<[string, string]> = [
      [CURSOR.id, 'opus'],
      [CURSOR.id, 'sonnet']
    ]

    it('slides over with Edit on the picked rows; holds, then settles, on the old ones', () => {
      vi.useFakeTimers()
      render(<PickPanel {...props({ favoritesStore: storeOf(BOTH) })} />)
      const history = watchStars()
      fireEvent.click(listed('Claude Sonnet'))

      // The picked rows: from the check's side (250) to flush before Edit
      // (236), so it starts 14px right and transitions to rest with Edit.
      const picked = starBoxes('Claude Sonnet')
      expect(picked).toHaveLength(2)
      for (const box of picked) {
        expect(history(box).some(heldAt(14))).toBe(true)
        expect(box.style.transform).toBe('')
        expect(box.style.transition).toBe(
          `transform ${PICKER_STAR_MOTION.enter.ms}ms ${PICKER_STAR_MOTION.enter.ease}`
        )
      }
      expect(PICKER_STAR_MOTION.enter).toEqual({
        ms: 200,
        ease: 'cubic-bezier(0.32, 0.72, 0, 1)'
      })

      // The old rows: the leaving copy still holds Edit's room, so the star
      // stays where it was (236, not its 206 there) while the copy fades.
      const old = starBoxes('Claude Opus')
      expect(old).toHaveLength(2)
      for (const box of old) {
        expect(box.style.transform).toBe('translateX(30px)')
        expect(box.style.transition).toBe('none')
      }

      // The copy unmounts: the star moves once, right into the freed room.
      settle()
      for (const box of starBoxes('Claude Opus')) {
        expect(history(box).some(heldAt(-14))).toBe(true)
        expect(box.style.transform).toBe('')
        expect(box.style.transition).toBe(
          `transform ${PICKER_STAR_MOTION.settle.ms}ms ${PICKER_STAR_MOTION.settle.ease}`
        )
      }

      // Rest: on transitionend, or by the fallback timer.
      for (const box of picked) fireEvent.transitionEnd(box)
      for (const box of picked) atRest(box)
      act(() => {
        vi.advanceTimersByTime(PICKER_STAR_MOTION.settle.ms + 100)
      })
      for (const box of starBoxes()) atRest(box)
    })

    it('nothing moves on open, on arrow keys, or when the level changes', () => {
      const history = watchStars()
      const store = storeOf(BOTH)
      const { rerender } = render(<Panel {...props({ favoritesStore: store })} />)
      const opus = listed('Claude Opus')
      act(() => opus.focus())
      fireEvent.keyDown(opus, { key: 'ArrowDown' })
      expect(listed('Claude Sonnet')).toHaveFocus()
      // High to Low: Edit narrows, the star with it, but nothing animates.
      rerender(<Panel {...props({ favoritesStore: store, effortValue: 'low' })} />)
      expect(screen.getAllByTestId('selector-edit')[0]).toHaveTextContent('Low')
      expect(starBoxes().length).toBeGreaterThan(0)
      for (const box of starBoxes()) expect(history(box)).toEqual([''])
    })

    it('reduced motion: the star never moves', () => {
      reducedMotion.current = true
      render(<PickPanel {...props({ favoritesStore: storeOf(BOTH) })} />)
      const history = watchStars()
      fireEvent.click(listed('Claude Sonnet'))
      expect(starBoxes('Claude Sonnet')).toHaveLength(2)
      for (const box of starBoxes()) expect(history(box)).toEqual([''])
    })

    it('a quick second pick retargets from where the star is, and everything ends at rest', () => {
      vi.useFakeTimers()
      render(
        <PickPanel
          {...props({ modelOption: THREE, favoritesStore: storeOf([[CURSOR.id, 'haiku']]) })}
        />
      )
      fireEvent.click(listed('Claude Sonnet'))
      const [sonnet] = starBoxes('Claude Sonnet')
      // Halfway through its slide in: 7px of its 14px still to go.
      act(() => {
        vi.advanceTimersByTime(50)
      })
      ;(sonnet as HTMLElement).style.transform = 'translateX(7px)'
      fireEvent.click(listed('Claude Haiku'))
      // Sonnet's Edit leaves: its star holds from that spot (243), not from
      // its rest (236): 37px right of its place beside the leaving copy (206).
      const [held] = starBoxes('Claude Sonnet')
      expect((held as HTMLElement).style.transform).toBe('translateX(37px)')

      act(() => {
        vi.advanceTimersByTime(PICKER_EDIT_MOTION.exitMs)
      })
      act(() => {
        vi.advanceTimersByTime(PICKER_STAR_MOTION.enter.ms + 100)
      })
      expect(exiting()).toHaveLength(0)
      expect(pressed()).toEqual(['Claude Haiku', 'Claude Haiku'])
      for (const box of starBoxes()) atRest(box)
    })
  })
})

describe('SelectorPanelV2 star beside Edit', () => {
  const starBox = (row: HTMLElement): HTMLElement | null | undefined =>
    row.parentElement?.querySelector<HTMLElement>('[data-star-box]')

  it('where Edit shows the level, the star sits flush before Edit, over a slot that ends the row', () => {
    render(<Panel {...props({ favoritesStore: storeOf([[CURSOR.id, 'opus']]) })} />)
    const selected = screen.getAllByRole('button', { name: 'Claude Opus', pressed: true })
    expect(selected).toHaveLength(2)
    for (const row of selected) {
      const fav = row.parentElement as HTMLElement
      const box = starBox(row)
      // The star's box ends where the row's box ends; Edit starts there.
      expect(box?.parentElement).toBe(fav)
      expect(classes(box)).toEqual(expect.arrayContaining(['absolute', 'right-0']))
      expect(classes(box)).not.toContain('right-7.5')
      expect(fav.nextElementSibling).toBe(editBeside(row))
      // No check: the reserved slot ends the row (no right padding), right
      // under the star, so the name's box ends a row gap before the star's.
      expect(row.querySelector('[data-row-check]')).toBeNull()
      const slot = row.lastElementChild
      expect(slot?.previousElementSibling).toHaveAttribute('data-row-name')
      expect(classes(slot)).toEqual(expect.arrayContaining(['shrink-0', 'w-5']))
      expect(classes(row)).toEqual(expect.arrayContaining(['pr-0', PICKER_ROW.gap]))
      // The star's hit area is unchanged.
      expect(classes(within(fav).getByTestId('selector-favorite'))).toContain('w-5')
    }
  })

  it('rows that keep the check keep the star left of it', () => {
    // An unselected row, and a selected one with no level (Edit reads "Edit").
    render(<Panel {...props({ thoughtLevel: null, favoritesStore: storeOf([]) })} />)
    for (const name of ['Claude Opus', 'Claude Sonnet']) {
      const row = screen.getByRole('button', { name })
      expect(classes(starBox(row))).toEqual(expect.arrayContaining(['absolute', 'right-7.5']))
      expect(classes(starBox(row))).not.toContain('right-0')
      expect(row.lastElementChild).toHaveAttribute('data-row-check')
      expect(classes(row)).not.toContain('pr-0')
    }
  })

  it('touch: the flush star keeps its 44px target, over a 44px slot', () => {
    render(<Panel {...props({ touch: true, favoritesStore: storeOf([]) })} />)
    const row = screen.getByRole('button', { name: 'Claude Opus', pressed: true })
    expect(classes(starBox(row))).toContain('right-0')
    expect(
      classes(within(row.parentElement as HTMLElement).getByTestId('selector-favorite'))
    ).toContain('w-11')
    expect(classes(row.lastElementChild)).toEqual(expect.arrayContaining(['shrink-0', 'w-11']))
    expect(classes(row)).toContain('pr-0')
  })
})

/** The Edit button sharing a row's hover box, if it has one. */
function editBeside(row: HTMLElement): HTMLElement | undefined {
  return screen.queryAllByTestId('selector-edit').find((edit) => edit.parentElement?.contains(row))
}

function arrowRightOpensNothing(row: HTMLElement): void {
  act(() => row.focus())
  fireEvent.keyDown(row, { key: 'ArrowRight' })
  expect(screen.queryByTestId('selector-edit-flyout')).toBeNull()
}

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

describe('SelectorPanelV2 agent row description', () => {
  const NAME = 'Opus via Claude · Claude Agent'
  const search = (): void => {
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models and agents' }), {
      target: { value: 'opus' }
    })
  }
  /** The visible tooltip box (the Radix content; it holds the hidden copy too). */
  const visibleTip = (): string | undefined =>
    screen.queryByRole('tooltip')?.parentElement?.textContent ?? undefined

  it('the agent, already in the name, is not read again: no aria-describedby', async () => {
    knownCatalogs.current = new Map([[CLAUDE.id, CLAUDE_CATALOG]])
    render(<Panel {...props({ agentRail: 'left' })} />)
    search()
    const row = screen.getByRole('button', { name: NAME })
    fireEvent.focus(row)
    const tip = await screen.findByRole('tooltip')
    expect(row).toHaveAccessibleName(NAME)
    expect(row).not.toHaveAttribute('aria-describedby')
    expect(row).toHaveAccessibleDescription('')
    expect(tip.textContent).not.toContain('Claude Agent')
    // The visual tooltip still says name, then agent.
    expect(
      visibleTip()
        ?.split('\n\n')
        .map((line) => line.trim())
    ).toEqual(['Opus via Claude', 'Claude Agent'])
  })

  it('with a description, it is described by the description alone', async () => {
    knownCatalogs.current = new Map([
      [
        CLAUDE.id,
        {
          ...CLAUDE_CATALOG,
          options: [{ value: 'claude-opus', name: 'Opus via Claude', description: 'Most capable' }]
        } as ModelCatalog
      ]
    ])
    render(<Panel {...props({ agentRail: 'left' })} />)
    search()
    const row = screen.getByRole('button', { name: NAME })
    fireEvent.focus(row)
    await screen.findByRole('tooltip')
    expect(row).toHaveAccessibleName(NAME)
    expect(row).toHaveAttribute('aria-describedby')
    expect(row).toHaveAccessibleDescription('Most capable')
    // The visual tooltip is unchanged: name, agent, description (the box also
    // holds the hidden copy, so the description shows up twice in its text).
    expect(
      visibleTip()
        ?.split('\n\n')
        .map((line) => line.trim())
    ).toEqual(['Opus via Claude', 'Claude Agent', 'Most capableMost capable'])
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
