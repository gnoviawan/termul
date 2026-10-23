/**
 * GPUIX override of `components/chat/chat-agent-prose.tsx`.
 *
 * The web renders a reply through Streamdown: DOM markdown with custom
 * components, Shiki code blocks and Mermaid. Here the reply's blocks are
 * native `<markdown>`, `<code>` cards and images (`src/chat/reply.tsx`),
 * stacked in one column. The transcript list does not use this: it gives
 * each block its own virtual-list row (`AgentReplyRows`).
 */

import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import type { FilePathResolutionContext } from '@/lib/file-path-links'
import { trailingMargin } from '../../../chat/prose-flow'
import { openFile, ReplyBlock, rowMargin, useReplyLinks, useReplyRows } from '../../../chat/reply'
import { tw } from '../../../style/tw'

export { TermulMarkdownImage } from '../../../chat/reply'

/** The open-in-editor link the web renders for a `<termul-file-path>` node. */
export function TermulFilePathButton({
  path,
  context,
  children
}: {
  path: string
  context: FilePathResolutionContext
  children: ReactNode
}) {
  return (
    <Button
      data-testid="termul-file-path"
      type="button"
      variant={null}
      size={null}
      title="Open in editor"
      className="cursor-pointer self-start text-left font-medium text-primary underline underline-offset-2"
      onClick={() => openFile(path, context)}
    >
      {children}
    </Button>
  )
}

/** Agent reply rendered as native markdown blocks. */
export function AgentProse({
  text,
  streaming,
  filePathContext
}: {
  text: string
  streaming: boolean
  reduced: boolean
  filePathContext?: FilePathResolutionContext
}) {
  const rows = useReplyRows(text, streaming, filePathContext !== undefined)
  const { onLink, dialog } = useReplyLinks(filePathContext)
  return (
    <div
      style={tw('flex min-w-0 flex-col text-sm leading-normal text-foreground')}
      testId="agent-prose"
    >
      {rows.map((row, i) => (
        <ReplyBlock
          key={row.key}
          row={row}
          marginTop={rowMargin(rows, i)}
          streaming={streaming}
          onLink={onLink}
          cwd={filePathContext?.cwd}
        />
      ))}
      {rows.length > 0 ? (
        <div style={{ height: trailingMargin(rows[rows.length - 1].flow) }} />
      ) : null}
      {dialog}
    </div>
  )
}
