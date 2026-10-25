/**
 * A turn's activity (`TurnActivity`) as several transcript rows: the
 * disclosure trigger, then one row per entry while it is open. As one row,
 * the live turn held every narration message, thought and tool run it had
 * streamed, and GPUI built and laid out all of it on every frame: under the
 * 8-chat stream-storm that row was 20,246 of 20,654 elements in the window
 * (tools/perf/hidden-panes.md). As rows, `<virtual-list>` builds only the
 * entries near the viewport.
 *
 * The web disclosure's spacing is kept as row padding (`my-1` on the root,
 * `pb-1 pl-4` on the body). GPUIX's `CollapseExpandMotion` already shows and
 * drops the body at once, so there is no height tween to lose.
 */

import { memo, useContext, useMemo } from 'react'
import type { TimelineItem } from '@/components/chat/chat-timeline'
import {
  groupWorkRuns,
  TurnActivityEntry,
  TurnActivityTrigger,
  useTurnActivityOpen
} from '@/components/chat/TurnActivity'
import type { EnterTracker } from '@/components/chat/use-enter-tracker'
import { Collapsible } from '@/components/ui/collapsible'
import type { ToolCall } from '@/lib/acp-api'
import type { FilePathResolutionContext } from '@/lib/file-path-links'
import { tw } from '../style/tw'
import { RowCountContext, type RowEdges, RowShell } from './row-shell'

/** `my-1` on the disclosure root. */
const ROOT_MARGIN = 4
/** `pb-1` on the disclosure body. */
const BODY_PAD = 4
const INDENT = tw('flex min-w-0 flex-col pl-4')

export interface TurnActivityRowsProps {
  rowKey: string
  items: TimelineItem[]
  active: boolean
  durationMs: number | null
  attentionRequired: boolean
  hasFinalResponse: boolean
  enter: EnterTracker
  statusLine: string | null
  filePathContext?: FilePathResolutionContext
  onOpenSubagent: (toolCall: ToolCall) => void
  edges: RowEdges
}

function TurnActivityRowsComponent({
  rowKey,
  items,
  active,
  durationMs,
  attentionRequired,
  hasFinalResponse,
  enter,
  statusLine,
  filePathContext,
  onOpenSubagent,
  edges
}: TurnActivityRowsProps) {
  const [open, setOpen] = useTurnActivityOpen(active, attentionRequired, hasFinalResponse)
  const { summary, workRuns } = useMemo(() => groupWorkRuns(items), [items])
  // A run renders at its first member; its later members have no row.
  const shown = useMemo(
    () =>
      open
        ? items.flatMap((item, index) => {
            const run = workRuns.get(item.key)
            return run && run.items[0] !== item ? [] : [index]
          })
        : [],
    [open, items, workRuns]
  )
  useContext(RowCountContext).set(rowKey, 1 + shown.length)

  return (
    <>
      <RowShell
        key={rowKey}
        testId={`chat-row-${rowKey}`}
        edges={{ first: edges.first, last: edges.last && shown.length === 0 }}
        padTop={ROOT_MARGIN}
        padBottom={shown.length === 0 ? ROOT_MARGIN : 0}
      >
        <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
          <TurnActivityTrigger
            open={open}
            active={active}
            durationMs={durationMs}
            attentionRequired={attentionRequired}
            statusLine={active ? statusLine : null}
            summary={summary}
          />
        </Collapsible>
      </RowShell>
      {shown.map((index, at) => {
        const last = at === shown.length - 1
        return (
          <RowShell
            key={`${rowKey}:${items[index].key}`}
            edges={{ first: false, last: edges.last && last }}
            padBottom={last ? BODY_PAD + ROOT_MARGIN : 0}
          >
            <div style={INDENT}>
              <TurnActivityEntry
                items={items}
                index={index}
                workRuns={workRuns}
                active={active}
                enter={enter}
                filePathContext={filePathContext}
                onOpenSubagent={onOpenSubagent}
              />
            </div>
          </RowShell>
        )
      })}
    </>
  )
}

export const TurnActivityRows = memo(
  TurnActivityRowsComponent,
  ({ edges: a, ...prev }, { edges: b, ...next }) =>
    a.first === b.first &&
    a.last === b.last &&
    (Object.keys(next) as (keyof typeof next)[]).every((key) => prev[key] === next[key])
)
