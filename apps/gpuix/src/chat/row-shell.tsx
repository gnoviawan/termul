/**
 * One `<virtual-list>` row of the transcript: the chat column (`max-w-3xl`,
 * centred) inside the viewport gutter, and the viewport's `py-4` on the
 * first and last rows. Spacing lives on rows as padding: a list row's
 * margins do not reach its neighbours.
 */

import { createContext, type ReactNode } from 'react'

/** `max-w-3xl`. */
const COLUMN_MAX = 768
/**
 * `px-5` on a pane at least 400px wide (`CHAT_GUTTER_X`), plus the web
 * viewport's `scrollbar-gutter: stable both-edges` (10px each side in Chromium).
 */
const GUTTER = 30
/** `py-4` on the viewport. */
const EDGE_PAD = 16

export interface RowEdges {
  /** The first row of the whole list. */
  first: boolean
  /** The last row of the whole list. */
  last: boolean
}

export function RowShell({
  testId,
  edges,
  padTop = 0,
  padBottom = 0,
  children
}: {
  testId?: string
  edges: RowEdges
  padTop?: number
  padBottom?: number
  children: ReactNode
}) {
  return (
    <div
      testId={testId}
      style={{
        display: 'flex',
        justifyContent: 'center',
        paddingLeft: GUTTER,
        paddingRight: GUTTER,
        paddingTop: padTop + (edges.first ? EDGE_PAD : 0),
        paddingBottom: padBottom + (edges.last ? EDGE_PAD : 0)
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          maxWidth: COLUMN_MAX,
          minWidth: 0
        }}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * Host rows per timeline item, written while the list renders. An agent reply
 * spans several rows, so the list's at-end sentinel (index === host row
 * count) needs the real count, not the item count.
 */
export const RowCountContext = createContext<Map<string, number>>(new Map())
