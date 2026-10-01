import { motion, useReducedMotion } from 'framer-motion'
import { useState } from 'react'
import { ArrowRight, ChevronRight } from '@/components/icons'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { AgentSwitchRecord } from '@/lib/acp-history-persistence'
import { cn } from '@/lib/utils'
import { useAcpStore, useAgentIcon, useAgentTemplateId } from '@/stores/acp-store'
import { AgentGlyph } from './AgentGlyph'
import { CHEVRON_TRANSITION } from './chat-motion'
import { stripHandoffHeader } from './handoff-summary'

/**
 * CAP-2 (spec-in-chat-agent-switch): the agent-switch divider.
 *
 * A centered hairline rule flanking an `old → new` identity chip — rendered
 * at the switch's seq position in the timeline (redesigned per the
 * spec-agent-switch-separator-redesign annotation: centered, not a
 * left-aligned row). Beneath it, the handoff summary renders as a distinct
 * bordered card that is VISIBLE BY DEFAULT; the collapse state is ephemeral
 * component-local state (never persisted), reset to expanded on remount. The
 * stable `switch.id` key (`switch:seq-<seq>`, assigned by the timeline) keeps
 * the virtualizer from remounting the row and losing the user's collapse
 * choice mid-session.
 *
 * Icons resolve through the `AgentGlyph` chokepoint: persisted custom icon →
 * `acp:<templateId>` bundled registry icon → lucide `Bot` fallback. Config
 * ids (not runtime agent ids) drive resolution — the marker is durable and
 * outlives any live process.
 */
function AgentSwitchIcon({ configId }: { configId: string }): React.JSX.Element {
  const templateId = useAgentTemplateId(null, configId || undefined)
  const icon = useAgentIcon(null, configId || undefined)
  return <AgentGlyph templateId={templateId} icon={icon} size={12} />
}

interface AgentSwitchSeparatorProps {
  /** The durable switch marker (from the host fold or the live event). */
  switch: AgentSwitchRecord
}

export function AgentSwitchSeparator({
  switch: switchRecord
}: AgentSwitchSeparatorProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  // Resolve both agent display names from the config registry (the marker
  // stores only durable config ids); fall back to the raw ids.
  const fromName = useAcpStore(
    (s) => s.agentConfigs.find((c) => c.id === switchRecord.fromConfigId)?.name
  )
  const toName = useAcpStore(
    (s) => s.agentConfigs.find((c) => c.id === switchRecord.toConfigId)?.name
  )
  // Visible by default (CAP-2); the user's collapse choice is ephemeral UI
  // state only — reopening the chat resets to expanded. Plain useState
  // suffices: nothing auto-toggles the section, so there is no auto-reset to
  // guard against.
  const [open, setOpen] = useState(true)

  // The wire summaryText carries a `# Conversation handoff` headline; the card
  // supplies its own label, so strip the wire header before rendering (shared
  // canonical strip — same `header + \n\n` prefix the host fold uses).
  const summaryBody = stripHandoffHeader(switchRecord.summaryText).trim()
  const hasSummary = summaryBody.length > 0
  const fromLabel = fromName || switchRecord.fromConfigId || 'previous agent'
  const toLabel = toName || switchRecord.toConfigId || 'another agent'
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="py-1">
      {/* Centered hairline divider: ── old → new ──. The flanking rules take
          the row's edges; the identity chip sits optically centered. When
          there is no summary the trigger is disabled — no dead toggle. */}
      <CollapsibleTrigger
        data-press-feedback="off"
        disabled={!hasSummary}
        aria-label={`Handoff: ${fromLabel} to ${toLabel}`}
        className="flex min-h-8 w-full cursor-pointer items-center gap-3 text-muted-foreground disabled:cursor-default"
      >
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
        <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2.5 py-0.5">
          <AgentSwitchIcon configId={switchRecord.fromConfigId} />
          <span className="max-w-24 truncate text-xs">{fromLabel}</span>
          <span aria-hidden="true" className="shrink-0 text-muted-foreground/70">
            <ArrowRight size={11} />
          </span>
          <AgentSwitchIcon configId={switchRecord.toConfigId} />
          <span className="max-w-24 truncate text-xs font-medium">{toLabel}</span>
        </span>
        {hasSummary && (
          <motion.span
            aria-hidden="true"
            className="shrink-0 text-muted-foreground"
            animate={{ rotate: open ? 90 : 0 }}
            transition={reduced ? { duration: 0 } : CHEVRON_TRANSITION}
          >
            <ChevronRight size={13} />
          </motion.span>
        )}
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
      </CollapsibleTrigger>
      <CollapsibleContent forceMount>
        <CollapseExpandMotion open={open}>
          {hasSummary && (
            <div
              className={cn(
                'mt-2 rounded-md border border-border/50 bg-muted/40 px-3 py-2',
                'text-xs text-muted-foreground',
                // Bound the card: the summary can run ~4KB of turn lines — a
                // wall of text mid-transcript. Cap at ~9 lines; the chevron
                // still fully collapses when it isn't needed.
                'max-h-40 overflow-y-auto',
                'whitespace-pre-wrap break-words'
              )}
            >
              {summaryBody}
            </div>
          )}
        </CollapseExpandMotion>
      </CollapsibleContent>
    </Collapsible>
  )
}
