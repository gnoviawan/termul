import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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
    screen.getByLabelText('Conversation agents, 2 total')
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
    const button = screen.getByRole('button', { name: /^Switched chat/ })
    expect(button.querySelector('span[role="img"]')).toBeNull()
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
    expect(screen.queryByLabelText(/^Conversation agents/)).not.toBeInTheDocument()
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
    expect(screen.queryByLabelText(/^Conversation agents/)).not.toBeInTheDocument()
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
    // Cap 3: first (original) + last two (current end of the chain), with
    // the collapsed middle as +3.
    const icons = glyphSpans()
    expect(icons).toHaveLength(3)
    const countBadge = screen.getByText('+3')
    expect(countBadge).toBeInTheDocument()
    // Pin the window (not just the count): the leading glyph is the ORIGINAL
    // id's bundled SVG (a1 = gemini, viewBox 0 0 24 24), the middle is the
    // second-to-last (a5 = glm-acp-agent, 0 0 16 16), and the trailing is
    // the CURRENT id (a6 = qwen-code, 0 0 141.38 140) — a first-3 window
    // regression ([a1,a2,a3]) fails these.
    expect(icons[0].querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(icons[1].querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 16 16')
    expect(icons[2].querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 141.38 140')
    // Pin the +N badge DOM position: after the leading icon, before the
    // trailing icons (the "collapse the middle" design).
    expect(icons[0].compareDocumentPosition(countBadge)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(countBadge.compareDocumentPosition(icons[1])).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(countBadge.compareDocumentPosition(icons[2])).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    // Screen-reader count covers the collapsed middle (2 rendered + 4).
    screen.getByLabelText('Conversation agents, 6 total')
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

  it('renders 3 icons without duplicate-key warnings on a switch-back chain', () => {
    // Story 3's appendOrderedAgents legitimately produces ['a','b','a'] on a
    // round-trip switch — the ordered sequence MEANING keeps the repeat, so
    // the row renders 3 icons (gemini → claude → gemini) and React must not
    // emit a duplicate-key console.error.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    stateRef.current = {
      agentConfigs: [
        config('cfg-original', TEMPLATE_GEMINI),
        config('cfg-current', TEMPLATE_CLAUDE)
      ]
    }
    render(
      <ChatHistoryEntryRow
        entry={entry({ agents: ['cfg-original', 'cfg-current', 'cfg-original'] })}
        onOpen={() => {}}
        onDelete={() => {}}
      />
    )
    const icons = glyphSpans()
    expect(icons).toHaveLength(3)
    // Ordered chain: original → current → original (repeat preserved).
    expect(icons[0].querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(icons[1].querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 1200 1200')
    expect(icons[2].querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('duplicate'),
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
    screen.getByLabelText('Conversation agents, 3 total')
    errorSpy.mockRestore()
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
    const sequence = screen.getByLabelText('Conversation agents, 2 total')
    // Known id → bundled glyph span; unknown id → Bot fallback svg.
    expect(sequence.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(1)
    const bot = sequence.querySelector('svg[data-termul-icon="Bot"]')
    expect(bot).toBeInTheDocument()
    expect(bot).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('ChatHistoryEntryRow actions and status slot', () => {
  it('names the trash button after the chat and keeps the generic hover title', () => {
    stateRef.current = { agentConfigs: [] }
    render(
      <ChatHistoryEntryRow
        entry={entry({ title: 'Resume token gate bug' })}
        onOpen={() => {}}
        onDelete={() => {}}
      />
    )

    const trash = screen.getByRole('button', { name: 'Delete Resume token gate bug' })
    expect(trash).toHaveAttribute('title', 'Delete chat')
    expect(screen.queryByRole('button', { name: 'Delete chat' })).not.toBeInTheDocument()
  })

  it('calls onDelete with the entry id (the confirm lives in the host)', () => {
    stateRef.current = { agentConfigs: [] }
    const onDelete = vi.fn()
    render(
      <ChatHistoryEntryRow entry={entry({ id: 'sess-9' })} onOpen={() => {}} onDelete={onDelete} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete Switched chat' }))

    expect(onDelete).toHaveBeenCalledWith('sess-9')
  })

  it('exposes focus targets for the host: the row id and both buttons', () => {
    stateRef.current = { agentConfigs: [] }
    const { container } = render(
      <ChatHistoryEntryRow entry={entry({ id: 'sess-9' })} onOpen={() => {}} onDelete={() => {}} />
    )

    const row = container.querySelector('[data-history-entry-id="sess-9"]')
    expect(row).not.toBeNull()
    expect(row?.querySelector('button[data-history-open]')).toBe(
      screen.getByRole('button', { name: /^Switched chat/ })
    )
    expect(row?.querySelector('button[data-history-delete]')).toBe(
      screen.getByRole('button', { name: 'Delete Switched chat' })
    )
  })

  it('renders the Failed badge inside the trailing status slot with its shipped classes', () => {
    stateRef.current = { agentConfigs: [] }
    const { container } = render(
      <ChatHistoryEntryRow
        entry={entry({ status: 'error' })}
        onOpen={() => {}}
        onDelete={() => {}}
      />
    )

    const slot = container.querySelector('[data-slot="history-status"]')
    expect(slot).not.toBeNull()
    const badge = within(slot as HTMLElement).getByText('Failed')
    expect(badge).toHaveClass('bg-destructive/15', 'text-destructive', 'text-3xs', 'rounded-sm')
    // Same position: after the title, before the relative time, in the open button.
    const openButton = screen.getByRole('button', { name: /^Switched chat/ })
    expect(openButton).toContainElement(slot as HTMLElement)
    const title = within(openButton).getByText('Switched chat')
    expect(title.compareDocumentPosition(slot as HTMLElement)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })

  it('renders no status slot for a healthy row', () => {
    stateRef.current = { agentConfigs: [] }
    const { container } = render(
      <ChatHistoryEntryRow entry={entry()} onOpen={() => {}} onDelete={() => {}} />
    )

    expect(container.querySelector('[data-slot="history-status"]')).toBeNull()
    expect(screen.queryByText('Failed')).not.toBeInTheDocument()
  })
})
