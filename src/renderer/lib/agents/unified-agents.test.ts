import { describe, expect, it } from 'vitest'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { TerminalAgentDefinition } from '@/lib/agents/agent-registry'
import {
  buildUnifiedAgents,
  normalizePersistedSelection,
  resolveSelection,
  selectionToPersisted
} from '@/lib/agents/unified-agents'

function cli(over: Partial<TerminalAgentDefinition> = {}): TerminalAgentDefinition {
  return {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    baseArgs: [],
    promptMode: 'positional',
    isBuiltIn: true,
    ...over
  }
}

function acp(over: Partial<StoredAgentConfig> = {}): StoredAgentConfig {
  return {
    id: 'acp-registry:claude-acp',
    name: 'Claude (ACP)',
    command: 'npx',
    args: ['-y', 'claude-acp'],
    env: {},
    ...over
  }
}

describe('buildUnifiedAgents', () => {
  it('joins a CLI agent and an enabled ACP config into one dual-mode row', () => {
    const entries = buildUnifiedAgents(
      [cli({ registryId: 'claude-acp' })],
      [acp({ templateId: 'claude-acp' })]
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].modes).toEqual(['cli', 'acp'])
    expect(entries[0].cli?.id).toBe('claude-code')
    expect(entries[0].acp?.id).toBe('acp-registry:claude-acp')
    expect(entries[0].key).toBe('unified:claude-acp')
  })

  it('keeps a CLI-only agent single-mode when no ACP config matches', () => {
    const entries = buildUnifiedAgents([cli({ registryId: 'claude-acp' })], [])
    expect(entries).toHaveLength(1)
    expect(entries[0].modes).toEqual(['cli'])
    expect(entries[0].key).toBe('cli:claude-code')
  })

  it('keeps an ACP-only config single-mode when no CLI agent matches', () => {
    const entries = buildUnifiedAgents([], [acp({ templateId: 'cursor' })])
    expect(entries).toHaveLength(1)
    expect(entries[0].modes).toEqual(['acp'])
    expect(entries[0].acp?.id).toBe('acp-registry:claude-acp')
    expect(entries[0].key).toBe('acp:acp-registry:claude-acp')
  })

  it('returns an empty list when both sources are empty', () => {
    expect(buildUnifiedAgents([], [])).toEqual([])
  })

  it('preserves CLI order first, then ACP-only configs', () => {
    const entries = buildUnifiedAgents(
      [cli({ id: 'a', name: 'A', registryId: undefined }), cli({ id: 'b', name: 'B' })],
      [acp({ id: 'acp-x', name: 'X', templateId: 'x' })]
    )
    expect(entries.map((e) => e.name)).toEqual(['A', 'B', 'X'])
  })

  it('does not double-count an ACP config already joined to a CLI agent', () => {
    const entries = buildUnifiedAgents(
      [cli({ registryId: 'claude-acp' })],
      [acp({ templateId: 'claude-acp' })]
    )
    expect(entries).toHaveLength(1)
  })

  it('produces unique keys when two CLI agents share a registryId, joining only the first', () => {
    const entries = buildUnifiedAgents(
      [
        cli({ id: 'claude-code', registryId: 'claude-acp' }),
        cli({ id: 'claude-custom', name: 'Claude Custom', registryId: 'claude-acp' })
      ],
      [acp({ templateId: 'claude-acp' })]
    )
    expect(entries).toHaveLength(2)
    const keys = entries.map((e) => e.key)
    expect(new Set(keys).size).toBe(2)
    // First claims the ACP join (dual-mode); the second stays CLI-only.
    expect(entries[0].modes).toEqual(['cli', 'acp'])
    expect(entries[1].modes).toEqual(['cli'])
  })

  it('keeps a second ACP config reachable when it shares a templateId', () => {
    const entries = buildUnifiedAgents(
      [],
      [
        acp({ id: 'acp-a', name: 'A', templateId: 'dup' }),
        acp({ id: 'acp-b', name: 'B', templateId: 'dup' })
      ]
    )
    expect(entries).toHaveLength(2)
    expect(new Set(entries.map((e) => e.key)).size).toBe(2)
    expect(entries.map((e) => e.acp?.id)).toEqual(['acp-a', 'acp-b'])
  })
})

describe('selectionToPersisted', () => {
  it('produces the underlying id for the chosen mode', () => {
    const [entry] = buildUnifiedAgents(
      [cli({ registryId: 'claude-acp' })],
      [acp({ templateId: 'claude-acp' })]
    )
    expect(selectionToPersisted(entry, 'cli')).toEqual({ agentId: 'claude-code', mode: 'cli' })
    expect(selectionToPersisted(entry, 'acp')).toEqual({
      agentId: 'acp-registry:claude-acp',
      mode: 'acp'
    })
  })

  it('returns null when the entry does not support the requested mode', () => {
    const [entry] = buildUnifiedAgents([cli({ registryId: undefined })], [])
    expect(selectionToPersisted(entry, 'acp')).toBeNull()
  })
})

describe('normalizePersistedSelection', () => {
  it('migrates a legacy { agentId } value to mode cli', () => {
    expect(normalizePersistedSelection({ agentId: 'claude-code' })).toEqual({
      agentId: 'claude-code',
      mode: 'cli'
    })
  })

  it('passes through a full { agentId, mode } value', () => {
    expect(normalizePersistedSelection({ agentId: 'x', mode: 'acp' })).toEqual({
      agentId: 'x',
      mode: 'acp'
    })
  })

  it('returns null for missing or malformed input', () => {
    expect(normalizePersistedSelection(null)).toBeNull()
    expect(normalizePersistedSelection({})).toBeNull()
    expect(normalizePersistedSelection({ agentId: '' })).toBeNull()
    expect(normalizePersistedSelection({ agentId: 42 })).toBeNull()
  })
})

describe('resolveSelection', () => {
  const entries = buildUnifiedAgents(
    [cli({ registryId: 'claude-acp' }), cli({ id: 'codex', name: 'Codex', registryId: undefined })],
    [acp({ templateId: 'claude-acp' })]
  )

  it('resolves a saved selection to its row key and mode', () => {
    expect(resolveSelection(entries, { agentId: 'codex', mode: 'cli' })).toEqual({
      key: 'cli:codex',
      mode: 'cli'
    })
  })

  it('falls back to a supported mode when the saved mode is no longer available', () => {
    const cliOnly = buildUnifiedAgents([cli({ registryId: undefined })], [])
    expect(resolveSelection(cliOnly, { agentId: 'claude-code', mode: 'acp' })).toEqual({
      key: 'cli:claude-code',
      mode: 'cli'
    })
  })

  it('returns null when no entry matches the saved id', () => {
    expect(resolveSelection(entries, { agentId: 'gone', mode: 'cli' })).toBeNull()
    expect(resolveSelection(entries, null)).toBeNull()
  })
})
