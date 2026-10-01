import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSwitchRecord } from '@/lib/acp-history-persistence'
import { AgentSwitchSeparator } from './AgentSwitchSeparator'

// The separator resolves icons from the store's agent-config registry via
// hooks; stub the store module so tests stay hermetic (no config loading).
vi.mock('@/stores/acp-store', () => ({
  useAcpStore: vi.fn(
    (selector: (s: { agentConfigs: Array<{ id: string; name?: string }> }) => unknown) =>
      selector({ agentConfigs: [{ id: 'claude', name: 'Claude' }] })
  ),
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
  it('renders the centered from → to identity divider', () => {
    render(<AgentSwitchSeparator switch={marker()} />)
    // Both agent identities appear inside the centered divider chip: the
    // source falls back to its raw config id when no display name resolves,
    // the target resolves 'Claude' from the agentConfigs registry.
    expect(screen.getByText('omp')).toBeInTheDocument()
    expect(screen.getByText('Claude')).toBeInTheDocument()
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
    expect(screen.getByText('Claude')).toBeInTheDocument()
  })

  it('strips the real `# Conversation handoff` wire header from the summary card', () => {
    // Production summaryText always starts with the wire header
    // (`buildHandoffSummary`); the card must show only the body.
    render(
      <AgentSwitchSeparator
        switch={marker({
          summaryText:
            '# Conversation handoff\n\nYou are taking over a conversation previously handled by OMP. Summary of the prior conversation:\n\n- login form work'
        })}
      />
    )
    expect(screen.queryByText(/# Conversation handoff/)).not.toBeInTheDocument()
    expect(screen.getByText(/login form work/)).toBeInTheDocument()
  })

  it('disables the toggle when the summary is empty — no dead chevron', () => {
    render(<AgentSwitchSeparator switch={marker({ summaryText: '' })} />)
    const trigger = screen.getByRole('button')
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveAttribute('aria-label', 'Handoff: omp to Claude')
  })
})
