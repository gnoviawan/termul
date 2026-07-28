import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SessionConfigOption } from '@/lib/acp-api'
import type { AcpSession } from '@/stores/acp-store'
import { ConfigChip, ModeChip } from './AgentHeader'

function clickMenuOption(name: string): void {
  const dialog = screen.getByRole('dialog')
  fireEvent.pointerDown(within(dialog).getByText(name))
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
