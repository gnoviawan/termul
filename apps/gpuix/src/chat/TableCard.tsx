/**
 * A markdown table as `ChatMarkdownTable` frames it: a bordered card with a
 * toolbar row above the table. The table itself is native markdown.
 *
 * The web's Copy and Download are menus (Markdown, CSV, TSV) and it has a
 * fullscreen view; here Copy and Download take the Markdown source and there
 * is no fullscreen yet.
 */

import { IconActionGroup } from '@/components/ui/icon-action-button'
import { tw } from '../style/tw'
import { CopyAction, DownloadAction } from './CodeCard'

const CARD = tw('flex min-w-0 flex-col overflow-hidden rounded-md border border-border/40')
const TOOLBAR = tw('flex justify-end border-b border-border/40 px-1 py-0.5')

export function TableCard({
  source,
  streaming,
  children
}: {
  source: string
  streaming: boolean
  children: React.ReactNode
}) {
  return (
    <div style={CARD} testId="chat-table-card">
      <div style={TOOLBAR}>
        <IconActionGroup className="gap-0.5" dense>
          <CopyAction code={source} disabled={streaming} />
          <DownloadAction code={source} language="md" disabled={streaming} />
        </IconActionGroup>
      </div>
      <div style={tw('bg-background')}>{children}</div>
    </div>
  )
}
