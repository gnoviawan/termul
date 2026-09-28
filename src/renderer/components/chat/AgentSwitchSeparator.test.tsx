import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSwitchRecord } from '@/lib/acp-history-persistence'
import { AgentSwitchSeparator } from './AgentSwitchSeparator'

// The separator resolves icons from the store's agent-config registry via
// hooks; stub the store module so tests stay hermetic (no config loading).
vi.mock('@/stores/acp-store', () => ({
  useAgentTemplateId: vi.fn(() => null),
  useAgentIcon: vi.fn(() => null)
}))

function marker(overrides: Partial<AgentSwitchRecord> = {}): AgentSwitchRecord {
  return {
    id: 'switch:seq-9',
    fromConfigId: 'omp',
    toConfigId: 'claude',
    newSessionId: 'session-2',
    summaryText: 'The user was building a login form; continue from there.',
    timestamp: 1_720_000_000_000,
    seq: 9,
    ...overrides
  }
}

describe('AgentSwitchSeparator (CAP-2)', () => {
  it('renders the from → to agent identity in the header', () => {
    render(<AgentSwitchSeparator switch={marker()} />)
    expect(screen.getByText('claude')).toBeInTheDocument()
    expect(screen.getByText('Switched to', { exact: false })).toBeInTheDocument()
  })

  it('shows the handoff summary by default (visible without interaction)', () => {
    render(<AgentSwitchSeparator switch={marker()} />)
    expect(
      screen.getByText('The user was building a login form; continue from there.')
    ).toBeInTheDocument()
    // Expanded by default: the trigger reports aria-expanded=true.
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  })

  it('collapses the summary on header click and re-expands on a second click', () => {
    render(<AgentSwitchSeparator switch={marker()} />)
    const summary = screen.getByText('The user was building a login form; continue from there.')
    expect(summary).toBeInTheDocument()

    const trigger = screen.getByRole('button')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('degrades gracefully when the to-config id is empty', () => {
    render(<AgentSwitchSeparator switch={marker({ toConfigId: '' })} />)
    expect(screen.getByText('another agent')).toBeInTheDocument()
  })

  it('renders an empty summary without crashing (corrupt record degradation)', () => {
    render(<AgentSwitchSeparator switch={marker({ summaryText: '' })} />)
    expect(screen.getByText('claude')).toBeInTheDocument()
  })
})
