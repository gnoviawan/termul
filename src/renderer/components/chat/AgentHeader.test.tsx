import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionConfigOption } from '@/lib/acp-api'
import type { AcpSession } from '@/stores/acp-store'
import { ConfigChip, ModeChip } from './AgentHeader'

const mobileShellRef = vi.hoisted(() => ({ current: false }))
vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileShellRef.current
}))

/**
 * The chip trigger (Radix sets `aria-haspopup="dialog"`). A closing menu stays
 * in the DOM for its close animation, so a row can share the chip's name.
 */
function pill(name: RegExp): HTMLElement {
  const match = screen
    .getAllByRole('button', { name })
    .find((b) => b.getAttribute('aria-haspopup') === 'dialog')
  if (!match) throw new Error(`No chip trigger named ${name}`)
  return match
}

function clickMenuOption(name: string): void {
  const dialog = screen.getByRole('dialog')
  fireEvent.click(within(dialog).getByText(name))
}

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return {
    ...actual,
    useReducedMotion: () => true
  }
})

function option(
  currentValue: string,
  options: Array<{ value: string; name: string }> = [
    { value: 'a', name: 'Alpha' },
    { value: 'b', name: 'Beta' },
    { value: 'c', name: 'Gamma' }
  ]
): SessionConfigOption {
  return {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue,
    options
  }
}

function session(currentModeId = 'agent'): AcpSession {
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
      currentModeId,
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

describe('ConfigChip pending selection', () => {
  it('renders an optional leading glyph before the model label', () => {
    render(
      <ConfigChip
        option={option('a')}
        disabled={false}
        onSelect={vi.fn()}
        leading={<span data-testid="agent-leading">icon</span>}
      />
    )
    const button = screen.getByRole('button', { name: /Alpha/ })
    expect(within(button).getByTestId('agent-leading')).toBeInTheDocument()
  })

  it('shows optimistic label and spinner while onSelect is pending', async () => {
    let resolveSelect!: () => void
    const onSelect = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSelect = resolve
        })
    )

    render(<ConfigChip option={option('a')} disabled={false} onSelect={onSelect} />)

    fireEvent.click(pill(/^Alpha$/))
    clickMenuOption('Beta')

    expect(onSelect).toHaveBeenCalledWith('b')
    expect(pill(/^Beta$/)).toHaveAttribute('aria-busy', 'true')

    await act(async () => {
      resolveSelect()
    })

    await waitFor(() => {
      expect(pill(/^Beta$/)).not.toHaveAttribute('aria-busy')
    })
  })

  it('soft-replaces: latest selection wins when a second pick happens mid-flight', async () => {
    const resolvers: Array<() => void> = []
    const onSelect = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve)
        })
    )

    render(<ConfigChip option={option('a')} disabled={false} onSelect={onSelect} />)

    fireEvent.click(pill(/^Alpha$/))
    clickMenuOption('Beta')
    expect(pill(/^Beta$/)).toHaveAttribute('aria-busy', 'true')

    fireEvent.click(pill(/^Beta$/))
    clickMenuOption('Gamma')
    expect(onSelect).toHaveBeenCalledTimes(2)
    expect(pill(/^Gamma$/)).toHaveAttribute('aria-busy', 'true')

    await act(async () => {
      resolvers[0]?.()
    })
    // Stale first completion must not clear the second pending state.
    expect(pill(/^Gamma$/)).toHaveAttribute('aria-busy', 'true')

    await act(async () => {
      resolvers[1]?.()
    })
    await waitFor(() => {
      expect(pill(/^Gamma$/)).not.toHaveAttribute('aria-busy')
    })
  })

  it('reverts optimistic label when onSelect rejects', async () => {
    let rejectSelect!: (err: Error) => void
    const onSelect = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSelect = reject
        })
    )

    render(<ConfigChip option={option('a')} disabled={false} onSelect={onSelect} />)

    fireEvent.click(pill(/^Alpha$/))
    clickMenuOption('Beta')
    expect(pill(/^Beta$/)).toBeInTheDocument()

    await act(async () => {
      rejectSelect(new Error('nope'))
    })

    await waitFor(() => {
      expect(pill(/^Alpha$/)).toBeInTheDocument()
      expect(pill(/^Alpha$/)).not.toHaveAttribute('aria-busy')
    })
  })

  it('no-ops when selecting the already displayed value', async () => {
    const onSelect = vi.fn(async () => undefined)
    render(<ConfigChip option={option('a')} disabled={false} onSelect={onSelect} />)

    fireEvent.click(pill(/^Alpha$/))
    clickMenuOption('Alpha')

    expect(onSelect).not.toHaveBeenCalled()
    expect(pill(/^Alpha$/)).not.toHaveAttribute('aria-busy')
  })
})

describe('ModeChip pending selection', () => {
  it('shows a leading bot icon beside the mode label', () => {
    render(
      <ModeChip session={session('agent')} disabled={false} onSelect={vi.fn()} label="Agent" />
    )
    const button = pill(/^Agent$/)
    expect(button.querySelector('svg')).toBeTruthy()
  })

  it('shows up to six modes without an inner scroll at 180px', () => {
    render(
      <ModeChip session={session('agent')} disabled={false} onSelect={vi.fn()} label="Agent" />
    )

    fireEvent.click(pill(/^Agent$/))

    const list = screen.getByTestId('mode-chip-options')
    expect(list).not.toHaveClass('max-h-[180px]')
    expect(list).toHaveClass('overflow-y-auto')
  })

  it('scrolls config chip options even without maxVisibleOptions', () => {
    render(<ConfigChip option={option('a')} disabled={false} onSelect={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))

    expect(screen.getByTestId('config-chip-options')).toHaveClass(
      'max-h-[180px]',
      'overflow-y-auto'
    )
  })

  it('shows optimistic mode label while pending', async () => {
    let resolveSelect!: () => void
    const onSelect = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSelect = resolve
        })
    )

    render(
      <ModeChip session={session('agent')} disabled={false} onSelect={onSelect} label="Agent" />
    )

    fireEvent.click(pill(/^Agent$/))
    clickMenuOption('Plan')

    expect(onSelect).toHaveBeenCalledWith('plan')
    expect(pill(/^Plan$/)).toHaveAttribute('aria-busy', 'true')

    await act(async () => {
      resolveSelect()
    })

    await waitFor(() => {
      expect(pill(/^Plan$/)).not.toHaveAttribute('aria-busy')
    })
  })

  it('reverts optimistic mode label when onSelect rejects', async () => {
    let rejectSelect!: (err: Error) => void
    const onSelect = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSelect = reject
        })
    )

    render(
      <ModeChip session={session('agent')} disabled={false} onSelect={onSelect} label="Agent" />
    )

    fireEvent.click(pill(/^Agent$/))
    clickMenuOption('Plan')
    expect(pill(/^Plan$/)).toBeInTheDocument()

    await act(async () => {
      rejectSelect(new Error('nope'))
    })

    await waitFor(() => {
      expect(pill(/^Agent$/)).toBeInTheDocument()
      expect(pill(/^Agent$/)).not.toHaveAttribute('aria-busy')
    })
  })
})

describe('mobile modal selection', () => {
  beforeEach(() => {
    mobileShellRef.current = true
  })
  afterEach(() => {
    mobileShellRef.current = false
  })

  it('opens a centered dialog with config chip options on mobile', () => {
    render(<ConfigChip option={option('a')} disabled={false} onSelect={vi.fn()} />)

    // No dialog before opening.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))

    // Modal dialog opens (not a popover — Radix Dialog renders role=dialog).
    const dialog = screen.getByRole('dialog', { name: 'Model' })
    expect(within(dialog).getByTestId('config-chip-options')).toBeInTheDocument()
    expect(within(dialog).getByText('Alpha')).toBeInTheDocument()
  })

  it('closes the modal and fires onSelect when an option is tapped', () => {
    const onSelect = vi.fn(async () => undefined)
    render(<ConfigChip option={option('a')} disabled={false} onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
    clickMenuOption('Beta')

    expect(onSelect).toHaveBeenCalledWith('b')
    expect(onSelect).toHaveBeenCalledTimes(1)
    // Modal closes after selection.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens a centered dialog with mode chip options on mobile', () => {
    render(
      <ModeChip session={session('agent')} disabled={false} onSelect={vi.fn()} label="Agent" />
    )

    fireEvent.click(pill(/^Agent$/))

    const dialog = screen.getByRole('dialog', { name: 'Agent' })
    expect(within(dialog).getByTestId('mode-chip-options')).toBeInTheDocument()
    expect(within(dialog).getByText('Plan')).toBeInTheDocument()
  })

  it('renders the search input inside the modal when showSearch is true', () => {
    // searchable + options count > maxVisibleOptions triggers showSearch
    render(
      <ConfigChip
        option={option('a')}
        disabled={false}
        onSelect={vi.fn()}
        searchable
        maxVisibleOptions={2}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByLabelText('Search models')).toBeInTheDocument()
  })

  it('applies a horizontal margin and larger max-width on the mobile modal panel', () => {
    render(<ConfigChip option={option('a')} disabled={false} onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))

    const dialog = screen.getByRole('dialog')
    // The dialog element (DialogContent) carries the margin + larger cap so it
    // never bleeds edge-to-edge on mobile, unlike the desktop w-56 popover.
    expect(dialog.className).toContain('w-[calc(100%-2rem)]')
    expect(dialog.className).toContain('max-w-md')
    expect(dialog.className).toContain('max-h-[80vh]')
  })

  it('closes the modal without firing onSelect on dismiss (Escape)', () => {
    const onSelect = vi.fn(async () => undefined)
    render(<ConfigChip option={option('a')} disabled={false} onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('closes the modal without firing onSelect on dismiss (close button)', () => {
    const onSelect = vi.fn(async () => undefined)
    render(<ConfigChip option={option('a')} disabled={false} onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    // The DialogContent close (X) button dismisses without selecting.
    fireEvent.click(screen.getByRole('button', { name: /Close/ }))

    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('does not open the modal when the chip is disabled', () => {
    render(<ConfigChip option={option('a')} disabled onSelect={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes the mode-chip modal and fires onSelect when an option is tapped', () => {
    const onSelect = vi.fn(async () => undefined)
    render(
      <ModeChip session={session('agent')} disabled={false} onSelect={onSelect} label="Agent" />
    )

    fireEvent.click(pill(/^Agent$/))
    clickMenuOption('Plan')

    expect(onSelect).toHaveBeenCalledWith('plan')
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

/** Claude Agent's modes, as `claude-agent-acp` sends them. */
function claudeSession(currentModeId = 'default'): AcpSession {
  return {
    ...session(currentModeId),
    modes: {
      currentModeId,
      availableModes: [
        { id: 'default', name: 'Manual', description: 'Always ask before making changes' },
        {
          id: 'acceptEdits',
          name: 'Accept edits',
          description: 'Automatically accept all file edits'
        },
        { id: 'plan', name: 'Plan', description: 'Create a plan before making changes' },
        { id: 'auto', name: 'Auto', description: 'Claude handles permission decisions' },
        {
          id: 'bypassPermissions',
          name: 'Bypass permissions',
          description: 'Accepts all permissions'
        }
      ]
    }
  }
}

function iconOf(element: HTMLElement): string | null {
  return element.querySelector('[data-termul-icon]')?.getAttribute('data-termul-icon') ?? null
}

describe('ModeChip mode menu (icons and risk groups)', () => {
  beforeEach(() => {
    mobileShellRef.current = false
  })

  it('groups modes by risk: Ask first, Let <agent> act, and Bypass set apart', () => {
    render(
      <ModeChip
        session={claudeSession()}
        disabled={false}
        onSelect={vi.fn()}
        label="Agent"
        agentName="Claude Agent"
      />
    )
    fireEvent.click(pill(/^Manual$/))

    const askFirst = screen.getByRole('group', { name: 'Ask first' })
    expect(
      within(askFirst)
        .getAllByRole('button')
        .map((b) => b.dataset.modeId)
    ).toEqual(['default', 'plan'])
    const act = screen.getByRole('group', { name: 'Let Claude Agent act' })
    expect(
      within(act)
        .getAllByRole('button')
        .map((b) => b.dataset.modeId)
    ).toEqual(['acceptEdits', 'auto'])
    const careful = screen.getByRole('group', { name: 'Use with care' })
    const bypass = within(careful).getByRole('button', { name: /Bypass permissions/ })
    expect(bypass).toHaveTextContent('Accepts all permissions. Use with care.')
    expect(bypass.querySelector('[data-termul-icon="ShieldAlert"]')).toHaveClass('text-warning')
  })

  it('gives each mode its hugeicons icon', () => {
    render(<ModeChip session={claudeSession()} disabled={false} onSelect={vi.fn()} label="Agent" />)
    fireEvent.click(pill(/^Manual$/))

    const icons = Object.fromEntries(
      screen
        .getAllByRole('button')
        .filter((b) => b.dataset.modeId)
        .map((b) => [b.dataset.modeId, iconOf(b)])
    )
    expect(icons).toEqual({
      default: 'Hand',
      plan: 'Maps',
      acceptEdits: 'FileEdit',
      auto: 'Sparkles',
      bypassPermissions: 'ShieldAlert'
    })
  })

  it('marks the selected mode with a check only (the fill means hover or focus)', () => {
    render(<ModeChip session={claudeSession()} disabled={false} onSelect={vi.fn()} label="Agent" />)
    fireEvent.click(pill(/^Manual$/))

    const manual = screen.getByRole('button', { name: /^Manual/, pressed: true })
    expect(manual).not.toHaveClass('bg-foreground/10')
    expect(manual.querySelector('[data-termul-icon="Check"]')).toHaveClass('opacity-100')
  })

  it('shows the current mode icon on the chip, in yellow for a risky mode', () => {
    const { rerender } = render(
      <ModeChip session={claudeSession()} disabled={false} onSelect={vi.fn()} label="Agent" />
    )
    expect(iconOf(pill(/^Manual$/))).toBe('Hand')

    rerender(
      <ModeChip
        session={claudeSession('bypassPermissions')}
        disabled={false}
        onSelect={vi.fn()}
        label="Agent"
      />
    )
    const chip = pill(/^Bypass permissions$/)
    expect(chip.querySelector('[data-termul-icon="ShieldAlert"]')).toHaveClass('text-warning')
  })

  it('maps Cursor and Codex modes, and puts unknown modes under Other modes', () => {
    const s = session('agent')
    s.modes = {
      currentModeId: 'agent',
      availableModes: [
        { id: 'agent', name: 'Agent' },
        { id: 'ask', name: 'Ask' },
        { id: 'read-only', name: 'Read-only' },
        { id: 'workspace-write', name: 'Workspace access' },
        { id: 'agent-full-access', name: 'Full access' },
        { id: 'yolo-2', name: 'Something new' }
      ]
    }
    render(<ModeChip session={s} disabled={false} onSelect={vi.fn()} label="Agent" />)
    fireEvent.click(pill(/^Agent$/))

    expect(
      within(screen.getByRole('group', { name: 'Ask first' }))
        .getAllByRole('button')
        .map((b) => [b.dataset.modeId, iconOf(b)])
    ).toEqual([
      ['ask', 'MessageQuestion'],
      ['read-only', 'Eye']
    ])
    expect(
      within(screen.getByRole('group', { name: 'Let the agent act' }))
        .getAllByRole('button')
        .map((b) => [b.dataset.modeId, iconOf(b)])
    ).toEqual([
      ['agent', 'Bot'],
      ['workspace-write', 'FolderEdit']
    ])
    expect(
      within(screen.getByRole('group', { name: 'Use with care' })).getByRole('button', {
        name: /Full access/
      })
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole('group', { name: 'Other modes' })).getByRole('button', {
        name: /Something new/
      })
    ).toBeInTheDocument()
  })

  it('selects a mode and closes the menu', async () => {
    const onSelect = vi.fn()
    render(
      <ModeChip session={claudeSession()} disabled={false} onSelect={onSelect} label="Agent" />
    )
    fireEvent.click(pill(/^Manual$/))
    fireEvent.click(screen.getByRole('button', { name: /^Auto/ }))

    expect(onSelect).toHaveBeenCalledWith('auto')
    await waitFor(() => expect(screen.queryByTestId('mode-chip-options')).toBeNull())
  })
})

describe('composer menus share the dropdown motion', () => {
  beforeEach(() => {
    mobileShellRef.current = false
  })

  it('the mode menu opens with the shared dropdown motion', () => {
    render(<ModeChip session={claudeSession()} disabled={false} onSelect={vi.fn()} label="Agent" />)
    fireEvent.click(pill(/^Manual$/))
    expect(screen.getByTestId('mode-chip-options').closest('[data-menu-motion]')).toHaveAttribute(
      'data-menu-motion',
      'dropdown'
    )
  })

  it('config chips open with the shared dropdown motion', () => {
    render(<ConfigChip option={option('a')} disabled={false} onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
    expect(screen.getByRole('dialog').closest('[data-menu-motion]')).toHaveAttribute(
      'data-menu-motion',
      'dropdown'
    )
  })
})
