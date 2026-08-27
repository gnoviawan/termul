import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionConfigOption } from '@/lib/acp-api'
import type { AcpSession } from '@/stores/acp-store'
import { ConfigChip, ModeChip } from './AgentHeader'

const mobileShellRef = vi.hoisted(() => ({ current: false }))
vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileShellRef.current
}))

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

    fireEvent.click(screen.getByRole('button', { name: /^Alpha$/ }))
    clickMenuOption('Beta')

    expect(onSelect).toHaveBeenCalledWith('b')
    expect(screen.getByRole('button', { name: /^Beta$/ })).toHaveAttribute('aria-busy', 'true')

    await act(async () => {
      resolveSelect()
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Beta$/ })).not.toHaveAttribute('aria-busy')
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

    fireEvent.click(screen.getByRole('button', { name: /^Alpha$/ }))
    clickMenuOption('Beta')
    expect(screen.getByRole('button', { name: /^Beta$/ })).toHaveAttribute('aria-busy', 'true')

    fireEvent.click(screen.getByRole('button', { name: /^Beta$/ }))
    clickMenuOption('Gamma')
    expect(onSelect).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: /^Gamma$/ })).toHaveAttribute('aria-busy', 'true')

    await act(async () => {
      resolvers[0]?.()
    })
    // Stale first completion must not clear the second pending state.
    expect(screen.getByRole('button', { name: /^Gamma$/ })).toHaveAttribute('aria-busy', 'true')

    await act(async () => {
      resolvers[1]?.()
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Gamma$/ })).not.toHaveAttribute('aria-busy')
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

    fireEvent.click(screen.getByRole('button', { name: /^Alpha$/ }))
    clickMenuOption('Beta')
    expect(screen.getByRole('button', { name: /^Beta$/ })).toBeInTheDocument()

    await act(async () => {
      rejectSelect(new Error('nope'))
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Alpha$/ })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /^Alpha$/ })).not.toHaveAttribute('aria-busy')
    })
  })

  it('no-ops when selecting the already displayed value', async () => {
    const onSelect = vi.fn(async () => undefined)
    render(<ConfigChip option={option('a')} disabled={false} onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('button', { name: /^Alpha$/ }))
    clickMenuOption('Alpha')

    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /^Alpha$/ })).not.toHaveAttribute('aria-busy')
  })
})

describe('ModeChip pending selection', () => {
  it('shows a leading bot icon beside the mode label', () => {
    render(
      <ModeChip session={session('agent')} disabled={false} onSelect={vi.fn()} label="Agent" />
    )
    const button = screen.getByRole('button', { name: /^Agent$/ })
    expect(button.querySelector('svg')).toBeTruthy()
  })

  it('scrolls agent mode options when the list exceeds the viewport', () => {
    render(
      <ModeChip session={session('agent')} disabled={false} onSelect={vi.fn()} label="Agent" />
    )

    fireEvent.click(screen.getByRole('button', { name: /^Agent$/ }))

    expect(screen.getByTestId('mode-chip-options')).toHaveClass('max-h-[180px]', 'overflow-y-auto')
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

    fireEvent.click(screen.getByRole('button', { name: /^Agent$/ }))
    clickMenuOption('Plan')

    expect(onSelect).toHaveBeenCalledWith('plan')
    expect(screen.getByRole('button', { name: /^Plan$/ })).toHaveAttribute('aria-busy', 'true')

    await act(async () => {
      resolveSelect()
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Plan$/ })).not.toHaveAttribute('aria-busy')
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

    fireEvent.click(screen.getByRole('button', { name: /^Agent$/ }))
    clickMenuOption('Plan')
    expect(screen.getByRole('button', { name: /^Plan$/ })).toBeInTheDocument()

    await act(async () => {
      rejectSelect(new Error('nope'))
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Agent$/ })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /^Agent$/ })).not.toHaveAttribute('aria-busy')
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

    fireEvent.click(screen.getByRole('button', { name: /^Agent$/ }))

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

    fireEvent.click(screen.getByRole('button', { name: /^Agent$/ }))
    clickMenuOption('Plan')

    expect(onSelect).toHaveBeenCalledWith('plan')
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
