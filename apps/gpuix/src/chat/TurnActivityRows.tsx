/**
 * A turn's activity as several transcript rows: the header (the web
 * `TurnActivity` trigger) and, while open, one row per entry of the shared
 * turn-activity model (a work run, a bare thought, intermediate narration).
 * As one row, a long agentic turn was rebuilt and laid out in full on every
 * frame (measured: draw time grew linearly with the turn's nodes); as rows,
 * `<virtual-list>` skips the entries off screen.
 */

import { memo, useContext, useMemo } from 'react'
import { ChatMessage } from '@/components/chat/ChatMessage'
import type { TurnActivityItem } from '@/components/chat/chat-timeline'
import { RowReveal } from '@/components/chat/RowReveal'
import { ThoughtGroup } from '@/components/chat/ThoughtGroup'
import {
  turnActivityLabel,
  turnActivityModel,
  useTurnActivityOpen
} from '@/components/chat/turn-activity-model'
import type { EnterTracker } from '@/components/chat/use-enter-tracker'
import { WorkRunGroup } from '@/components/chat/WorkRunGroup'
import { ChevronDown, ChevronRight } from '@/components/icons'
import { Button } from '@/components/ui/button'
import type { ToolCall } from '@/lib/acp-api'
import type { FilePathResolutionContext } from '@/lib/file-path-links'
import { tw } from '../style/tw'
import { DiffStatCounts } from '../ui/diff-stat-counts'
import { RowCountContext, type RowEdges, RowShell } from './row-shell'

/** The web Collapsible's `my-1`. */
const TURN_PAD = 4
/** The web content's `pl-4`. */
const ENTRY_INDENT = 16

const TRIGGER = 'flex w-full min-h-7 cursor-pointer items-center gap-1.5 text-left'

export interface TurnActivityRowsProps {
  item: TurnActivityItem
  enter: EnterTracker
  /** Live OpenCode compaction or retry line; the list passes null to a settled turn. */
  statusLine: string | null
  filePathContext?: FilePathResolutionContext
  onOpenSubagent: (toolCall: ToolCall) => void
  edges: RowEdges
}

function TurnActivityRowsComponent({
  item,
  enter,
  statusLine,
  filePathContext,
  onOpenSubagent,
  edges
}: TurnActivityRowsProps) {
  const { key, items, active, durationMs, attentionRequired, hasFinalResponse } = item
  const [open, setOpen] = useTurnActivityOpen(active, attentionRequired, hasFinalResponse)
  const { entries, summary } = useMemo(() => turnActivityModel(items, active), [items, active])
  const label = turnActivityLabel(active, durationMs, statusLine)
  const shown = open ? entries : []
  const counts = useContext(RowCountContext)
  counts.set(key, 1 + shown.length)

  const attention = attentionRequired && !active
  const Chevron = open ? ChevronDown : ChevronRight
  const ink = attention ? 'text-destructive' : 'text-muted-foreground'
  return (
    <>
      <RowShell
        key={key}
        testId={`chat-row-${key}`}
        edges={{ first: edges.first, last: edges.last && shown.length === 0 }}
        padTop={TURN_PAD}
        padBottom={shown.length === 0 ? TURN_PAD : 0}
      >
        <Button
          data-testid="turn-activity-trigger"
          type="button"
          variant={null}
          size={null}
          aria-expanded={open}
          className={TRIGGER}
          onClick={() => setOpen((value) => !value)}
        >
          <Chevron size={13} className={`shrink-0 ${ink}`} />
          <div style={tw('flex min-w-0 flex-1 flex-row items-center gap-1.5')}>
            <text style={tw(`text-xs font-medium ${ink}`)}>{label}</text>
            {summary ? (
              <div style={tw('flex shrink-0 flex-row text-2xs tabular-nums')}>
                <DiffStatCounts added={summary.added} removed={summary.removed} omitZero />
              </div>
            ) : null}
            {attention ? <text style={tw(`text-xs ${ink}`)}>· needs attention</text> : null}
          </div>
        </Button>
      </RowShell>
      {shown.map((entry, i) => {
        const last = i === shown.length - 1
        return (
          <RowShell
            key={`${key}/${entry.key}`}
            testId={`chat-row-${key}/${entry.key}`}
            edges={{ first: false, last: edges.last && last }}
            padBottom={last ? TURN_PAD * 2 : 0}
          >
            <div style={{ paddingLeft: ENTRY_INDENT, minWidth: 0 }}>
              {entry.kind === 'work-run' ? (
                <WorkRunGroup
                  items={entry.items}
                  summary={entry.summary}
                  active={active}
                  isLiveTail={entry.isLiveTail}
                  failed={entry.failed}
                  enter={enter}
                  filePathContext={filePathContext}
                  onOpenSubagent={onOpenSubagent}
                />
              ) : entry.kind === 'thought' ? (
                <RowReveal
                  animate={enter.animate(entry.key)}
                  staggerIndex={enter.staggerIndex(entry.key)}
                >
                  <ThoughtGroup messages={entry.messages} isLiveTail={entry.isLiveTail} />
                </RowReveal>
              ) : (
                <ChatMessage
                  message={entry.message}
                  showHeader={false}
                  isLast={entry.isLast}
                  animateEnter={enter.animate(entry.message.id)}
                  filePathContext={filePathContext}
                />
              )}
            </div>
          </RowShell>
        )
      })}
    </>
  )
}

export const TurnActivityRows = memo(TurnActivityRowsComponent)
