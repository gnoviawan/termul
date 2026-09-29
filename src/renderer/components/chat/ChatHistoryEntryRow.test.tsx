import { render, screen } from '@testing-library/react'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'

// Real `AgentGlyph` (the chokepoint under test): mock only the acp-store so
// per-config resolution (useAgentTemplateId/useAgentIcon) is seeded from
// `agentConfigs`, exercising icon → acp:<templateId> → Bot fallback for real.

const { stateRef } = vi.hoisted(() => ({
  stateRef: { current: {} as Record<string, unknown> }
}))

vi.mock('@/stores/acp-store', () => {
  // Mirrors the real hooks' config branch: `agentConfigs.find(id)` then
  // templateId/icon. agentId is always null from the row's per-config path.
  const useAgentTemplateId = (agentId: string | null, agentConfigId?: string) => {
    void agentId
    const configs = (stateRef.current.agentConfigs ?? []) as StoredAgentConfig[]
    if (agentConfigId) {
      const config = configs.find((c) => c.id === agentConfigId)
      if (config?.templateId) return config.templateId
    }
    return null
  }
  const useAgentIcon = (agentId: string | null, agentConfigId?: string) => {
    void agentId
    const configs = (stateRef.current.agentConfigs ?? []) as StoredAgentConfig[]
    return configs.find((c) => c.id === agentConfigId)?.icon ?? null
  }
  return { useAgentTemplateId, useAgentIcon }
})

import { ChatHistoryEntryRow, type ChatHistorySidebarEntry } from './ChatHistoryEntryRow'

/** An acp catalog templateId whose bundled SVG exists (Gemini's spark icon). */
const TEMPLATE_GEMINI = 'gemini'
/** A second acp catalog templateId with a distinct bundled SVG (Claude). */
const TEMPLATE_CLAUDE = 'claude-acp'

function config(id: string, templateId: string): StoredAgentConfig {
  return {
    id,
    name: `Agent ${id}`,
    command: 'echo',
    args: [],
    env: {},
    templateId
  }
}

function entry(overrides: Partial<ChatHistorySidebarEntry> = {}): ChatHistorySidebarEntry {
  return {
    id: 's1',
    title: 'Switched chat',
    messageCount: 1,
    status: 'active',
    discovered: false,
    agentId: 'a',
    agentConfigId: 'cfg-original',
    lastActivityAt: 0,
    canOpen: true,
    ...overrides
  }
}

function glyphSpans(): HTMLElement[] {
  // AgentGlyph renders a sanitized catalog/custom SVG as a span
  // (dangerouslySetInnerHTML); the Bot fallback is an svg[data-termul-icon].
  return Array.from(document.querySelectorAll<HTMLElement>('button span[aria-hidden="true"]'))
}

describe('ChatHistoryEntryRow agent sequence', () => {
  it('renders the ordered two-icon sequence for a switched chat', () => {
    stateRef.current = {
      agentConfigs: [
        config('cfg-original', TEMPLATE_GEMINI),
        config('cfg-current', TEMPLATE_CLAUDE)
      ]
    }
    render(
      <ChatHistoryEntryRow
        entry={entry({ agents: ['cfg-original', 'cfg-current'] })}
        onOpen={() => {}}
        onDelete={() => {}}
      />
    )
    // Ordered: original (first) leftmost → current (last), both resolved
    // through the real AgentGlyph chokepoint (bundled catalog SVGs), inside
    // the sequence wrapper.
    screen.getByLabelText('Conversation agents')
    const icons = glyphSpans()
    expect(icons).toHaveLength(2)
    expect(icons[0].querySelector('svg')).not.toBeNull()
    expect(icons[1].querySelector('svg')).not.toBeNull()
    expect(icons[0].innerHTML).not.toBe(icons[1].innerHTML)
    // The template ids resolve to distinct bundled SVGs — gemini's spark
    // (viewBox 0 0 24 24) and claude (0 0 1200 1200) — pinning the ORDER:
    // original leftmost, current last.
    const geminiSvg = icons.find(
      (i) => i.querySelector('svg')?.getAttribute('viewBox') === '0 0 24 24'
    )
    const claudeSvg = icons.find(
      (i) => i.querySelector('svg')?.getAttribute('viewBox') === '0 0 1200 1200'
    )
    expect(geminiSvg).toBe(icons[0])
    expect(claudeSvg).toBe(icons[1])
    // No overflow count on a within-cap sequence.
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument()
  })

  it('renders exactly the single icon for an unswitched row (agents absent)', () => {
    stateRef.current = { agentConfigs: [config('cfg-original', TEMPLATE_GEMINI)] }
    const { container, rerender } = render(
      <ChatHistoryEntryRow entry={entry()} onOpen={() => {}} onDelete={() => {}} />
    )
    expect(glyphSpans()).toHaveLength(1)
    // No sequence wrapper: the glyph sits directly in the row button, whose
    // accessible name is the title (the open button — not delete).
    const button = screen.getByRole('button', { name: /Switched chat/ })
    expect(button.querySelector('span[aria-label="Conversation agents"]')).toBeNull()
    // Byte-identical DOM when `agents` is present-but-undefined vs absent.
    const before = container.innerHTML
    rerender(
      <ChatHistoryEntryRow
        entry={entry({ agents: undefined })}
        onOpen={() => {}}
        onDelete={() => {}}
      />
    )
    expect(container.innerHTML).toBe(before)
  })

  it('renders exactly the single icon for a single-entry agents cache', () => {
    stateRef.current = { agentConfigs: [config('cfg-original', TEMPLATE_GEMINI)] }
    render(
      <ChatHistoryEntryRow
        entry={entry({ agents: ['cfg-original'] })}
        onOpen={() => {}}
        onDelete={() => {}}
      />
    )
    expect(glyphSpans()).toHaveLength(1)
    expect(screen.queryByLabelText('Conversation agents')).not.toBeInTheDocument()
  })

  it('renders the single icon when every agents entry is the same id', () => {
    // Defensive: story 3's write path consecutive-dedupes, but an all-equal
    // cache must degrade to today's single icon (not a 1-icon sequence).
    stateRef.current = { agentConfigs: [config('cfg-original', TEMPLATE_GEMINI)] }
    render(
      <ChatHistoryEntryRow
        entry={entry({ agents: ['cfg-original', 'cfg-original'] })}
        onOpen={() => {}}
        onDelete={() => {}}
      />
    )
    expect(glyphSpans()).toHaveLength(1)
    expect(screen.queryByLabelText('Conversation agents')).not.toBeInTheDocument()
  })

  it('collapses a 6-agent chain to first + +3 + last (leading and trailing kept)', () => {
    stateRef.current = {
      agentConfigs: [
        config('a1', TEMPLATE_GEMINI),
        config('a2', TEMPLATE_CLAUDE),
        config('a3', 'codex-acp'),
        config('a4', 'grok-build'),
        config('a5', 'glm-acp-agent'),
        config('a6', 'qwen-code')
      ]
    }
    render(
      <ChatHistoryEntryRow
        entry={entry({ agents: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'] })}
        onOpen={() => {}}
        onDelete={() => {}}
      />
    )
    // Cap 3: first (original) + last two (current end of the chain).
    expect(glyphSpans()).toHaveLength(3)
    expect(screen.getByText('+3')).toBeInTheDocument()
    // Leading icon is the original (a1's gemini template), trailing is the
    // current (a6's qwen-code template) — distinct bundled SVGs.
    const icons = glyphSpans()
    expect(icons[0].innerHTML).not.toBe(icons[2].innerHTML)
  })

  it('dedups consecutive duplicate ids defensively', () => {
    stateRef.current = {
      agentConfigs: [
        config('cfg-original', TEMPLATE_GEMINI),
        config('cfg-current', TEMPLATE_CLAUDE)
      ]
    }
    render(
      <ChatHistoryEntryRow
        entry={entry({ agents: ['cfg-original', 'cfg-original', 'cfg-current'] })}
        onOpen={() => {}}
        onDelete={() => {}}
      />
    )
    expect(glyphSpans()).toHaveLength(2)
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument()
  })

  it('renders the Bot fallback for unknown config ids without error', () => {
    stateRef.current = { agentConfigs: [config('cfg-known', TEMPLATE_GEMINI)] }
    render(
      <ChatHistoryEntryRow
        entry={entry({ agents: ['cfg-known', 'cfg-unknown'] })}
        onOpen={() => {}}
        onDelete={() => {}}
      />
    )
    const sequence = screen.getByLabelText('Conversation agents')
    // Known id → bundled glyph span; unknown id → Bot fallback svg.
    expect(sequence.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(1)
    const bot = sequence.querySelector('svg[data-termul-icon="Bot"]')
    expect(bot).toBeInTheDocument()
    expect(bot).toHaveAttribute('aria-hidden', 'true')
  })
})
