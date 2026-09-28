import { motion, useReducedMotion } from 'framer-motion'
import { ArrowRight, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker'
import type { AgentSwitchRecord } from '@/lib/acp-history-persistence'
import { cn } from '@/lib/utils'
import { useAgentIcon, useAgentTemplateId } from '@/stores/acp-store'
import { AgentGlyph } from './AgentGlyph'
import { CHEVRON_TRANSITION } from './chat-motion'

/**
 * CAP-2 (spec-in-chat-agent-switch): the borderless agent-switch separator.
 *
 * A minimal, immersive row — `(old-agent icon) → (new-agent icon)` in a
 * borderless `Marker` header, no divider chrome — rendered at the switch's
 * seq position in the timeline. Beneath it, the handoff summary renders as
 * a collapsible section that is VISIBLE BY DEFAULT; the collapse state is
 * ephemeral component-local state (never persisted), reset to expanded on
 * remount. The stable `switch.id` key (`switch:seq-<seq>`, assigned by the
 * timeline) keeps the virtualizer from remounting the row and losing the
 * user's collapse choice mid-session.
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
  // Visible by default (CAP-2); the user's collapse choice is ephemeral UI
  // state only — reopening the chat resets to expanded.
  const [open, setOpen] = useState(true)
  const userOverride = useRef(false)

  // Nothing auto-toggles the section (unlike ThoughtGroup's streaming
  // auto-open); the effect only re-syncs after an explicit reset, which
  // never happens today. Kept for the userOverride contract symmetry.
  useEffect(() => {
    if (userOverride.current) return
    setOpen(true)
  }, [])

  const handleOpenChange = (next: boolean): void => {
    userOverride.current = true
    setOpen(next)
  }

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange} className="py-1">
      <CollapsibleTrigger
        data-press-feedback="off"
        className="flex min-h-8 w-full cursor-pointer items-center gap-1 text-left"
      >
        {/* Borderless marker header: old-agent icon → new-agent icon. */}
        <Marker
          variant="default"
          className="inline-flex min-w-0 flex-1 font-medium text-muted-foreground"
        >
          <MarkerIcon>
            <AgentSwitchIcon configId={switchRecord.fromConfigId} />
          </MarkerIcon>
          <motion.span
            aria-hidden="true"
            className="shrink-0 px-0.5 text-muted-foreground/70"
            animate={reduced ? undefined : { scale: 1 }}
          >
            <ArrowRight size={11} />
          </motion.span>
          <MarkerIcon>
            <AgentSwitchIcon configId={switchRecord.toConfigId} />
          </MarkerIcon>
          <MarkerContent className="min-w-0 flex-1">
            <span className="truncate font-normal">
              Switched to{' '}
              <span className="font-medium">{switchRecord.toConfigId || 'another agent'}</span>
            </span>
          </MarkerContent>
        </Marker>
        <motion.span
          aria-hidden="true"
          className="shrink-0 text-muted-foreground"
          animate={{ rotate: open ? 90 : 0 }}
          transition={reduced ? { duration: 0 } : CHEVRON_TRANSITION}
        >
          <ChevronRight size={13} />
        </motion.span>
      </CollapsibleTrigger>
      <CollapsibleContent forceMount>
        <CollapseExpandMotion open={open}>
          <div
            className={cn(
              'mt-1.5 pl-3 text-xs text-muted-foreground',
              'whitespace-pre-wrap break-words'
            )}
          >
            {switchRecord.summaryText}
          </div>
        </CollapseExpandMotion>
      </CollapsibleContent>
    </Collapsible>
  )
}
