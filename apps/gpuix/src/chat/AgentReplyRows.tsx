/**
 * A settled or streaming agent message as several transcript rows: one per
 * reply block, then the message actions. This is `ChatMessage`'s agent layout
 * (`Message` py-2, a ghost bubble, `MessageActions` 4px below), flattened so
 * every block is a direct `<virtual-list>` row. GPUI then builds and lays out
 * only the blocks near the viewport; as one row, a long streaming reply was
 * rebuilt in full on every frame (measured: draw time grew with the reply).
 *
 * Messages with attachments keep the shared `ChatMessage` (one row).
 */

import { memo, useContext } from 'react'
import { MessageActions } from '@/components/chat/MessageActions'
import type { FilePathResolutionContext } from '@/lib/file-path-links'
import { normalizePlanFenceBoundary, stripEmptyFences } from '@/lib/strip-empty-fences'
import type { ChatMessage } from '@/stores/acp-store'
import { tw } from '../style/tw'
import { trailingMargin } from './prose-flow'
import { ReplyBlock, rowMargin, useReplyLinks, useReplyRows } from './reply'
import { RowCountContext, type RowEdges, RowShell } from './row-shell'

/** `Message` className `py-2`. */
const MESSAGE_PAD = 8
/** `MessageContent` `gap-1`. */
const CONTENT_GAP = 4

function proseOf(message: ChatMessage, streaming: boolean): string {
  const text = message.blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
  return normalizePlanFenceBoundary(stripEmptyFences(text, streaming))
}

export function hasMediaBlocks(message: ChatMessage): boolean {
  return message.blocks.some((b) => b.type !== 'text')
}

export interface AgentReplyRowsProps {
  rowKey: string
  message: ChatMessage
  isLast: boolean
  isTurnTail: boolean
  turnText?: string
  actionsPinned: boolean
  onRetry?: () => void
  filePathContext?: FilePathResolutionContext
  edges: RowEdges
}

function AgentReplyRowsComponent({
  rowKey,
  message,
  isLast,
  isTurnTail,
  turnText,
  actionsPinned,
  onRetry,
  filePathContext,
  edges
}: AgentReplyRowsProps) {
  const streaming = message.streaming && isLast
  const prose = proseOf(message, streaming)
  const rows = useReplyRows(prose, streaming, filePathContext !== undefined)
  const { onLink, dialog } = useReplyLinks(filePathContext)
  const hasActions = !message.streaming && isTurnTail
  const counts = useContext(RowCountContext)
  const total = Math.max(1, rows.length) + (hasActions ? 1 : 0)
  counts.set(rowKey, total)

  const blockRows =
    rows.length === 0 ? (
      <RowShell
        key={`${rowKey}:caret`}
        testId={`chat-row-${rowKey}`}
        edges={{ first: edges.first, last: edges.last && !hasActions }}
        padTop={MESSAGE_PAD}
        padBottom={hasActions ? 0 : MESSAGE_PAD}
      >
        {streaming ? (
          <div style={{ ...tw('bg-foreground'), width: 2, height: 15, marginLeft: 2 }} />
        ) : null}
      </RowShell>
    ) : (
      rows.map((row, i) => {
        const lastBlock = i === rows.length - 1
        return (
          <RowShell
            key={`${rowKey}:${row.key}`}
            testId={i === 0 ? `chat-row-${rowKey}` : undefined}
            edges={{ first: edges.first && i === 0, last: edges.last && lastBlock && !hasActions }}
            padTop={i === 0 ? MESSAGE_PAD : 0}
            padBottom={lastBlock ? trailingMargin(row.flow) + (hasActions ? 0 : MESSAGE_PAD) : 0}
          >
            <ReplyBlock
              row={row}
              marginTop={i === 0 ? rowMargin(rows, 0) : rowMargin(rows, i)}
              streaming={streaming}
              onLink={onLink}
              cwd={filePathContext?.cwd}
            />
            {i === 0 ? dialog : null}
          </RowShell>
        )
      })
    )
  return (
    <>
      {blockRows}
      {hasActions ? (
        <RowShell
          key={`${rowKey}:actions`}
          edges={{ first: false, last: edges.last }}
          padTop={CONTENT_GAP}
          padBottom={MESSAGE_PAD}
        >
          <MessageActions
            text={turnText ?? prose}
            align="start"
            pinned={actionsPinned}
            reveal="hover"
            onRetry={onRetry}
          />
        </RowShell>
      ) : null}
    </>
  )
}

export const AgentReplyRows = memo(AgentReplyRowsComponent)
