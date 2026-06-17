import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import { AcpAgentsSettings } from './AcpAgentsSettings'

const { stateRef } = vi.hoisted(() => ({
  stateRef: {
    current: {
      agentConfigs: [] as StoredAgentConfig[],
      warmingConfigs: {},
      configToLiveAgent: {},
      agentStatus: {}
    }
  }
}))

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: vi.fn(() => 'windows'),
  arch: vi.fn(() => 'x86_64')
}))

vi.mock('@/stores/acp-store', () => {
  const useAcpStore = (sel?: (s: typeof stateRef.current) => unknown) =>
    sel ? sel(stateRef.current) : stateRef.current
  const useConfigWarmState = () => ({ connected: false, warming: false })
  return { useAcpStore, useConfigWarmState }
})

describe('AcpAgentsSettings', () => {
  beforeEach(() => {
    stateRef.current.agentConfigs = []
  })

  it('shows supported ACP agent status without enable toggles', () => {
    render(<AcpAgentsSettings />)

    expect(screen.getByText('Codex CLI')).toBeInTheDocument()
    expect(screen.getByText('Claude Agent')).toBeInTheDocument()
    expect(screen.getByText('Gemini CLI')).toBeInTheDocument()
    expect(screen.getByText('Cursor')).toBeInTheDocument()
    expect(screen.getByText('OpenCode')).toBeInTheDocument()
    expect(screen.getByText('pi ACP')).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.getAllByText('Install from Agent Chat')).toHaveLength(2)
  })
})
