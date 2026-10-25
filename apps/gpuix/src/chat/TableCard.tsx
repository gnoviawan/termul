/**
 * A markdown table as `ChatMarkdownTable` frames it: a bordered card with a
 * toolbar row above the table (copy, download, fullscreen). The table itself
 * is native markdown.
 *
 * The web's Copy and Download are menus (Markdown, CSV, TSV); here they take
 * the Markdown source. Fullscreen fills the window like the web's
 * `TableFullscreen` dialog, with its own copy, download and exit buttons;
 * Escape closes it.
 */

import { useState } from 'react'
import { Maximize2, X } from '@/components/icons'
import { IconActionButton, IconActionGroup } from '@/components/ui/icon-action-button'
import { LAYER } from '../compat/stacking'
import { tw } from '../style/tw'
import { CopyAction, DownloadAction } from './CodeCard'

const CARD = tw('flex min-w-0 flex-col overflow-hidden rounded-md border border-border/40')
const TOOLBAR = tw('flex justify-end border-b border-border/40 px-1 py-0.5')

/** The web's fullscreen `DialogContent` (`inset-0 h-dvh w-screen bg-background p-0`, no close X). */
const FULLSCREEN = tw('absolute inset-0 flex flex-col bg-background')

function TableFullscreen({
  source,
  streaming,
  children
}: {
  source: string
  streaming: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <IconActionButton
        label="View fullscreen"
        onClick={() => setOpen(true)}
        disabled={streaming}
        size="sm"
      >
        <Maximize2 />
      </IconActionButton>
      {open ? (
        <anchored fill="window" priority={LAYER.dialog} style={{ backgroundColor: 'transparent' }}>
          <div
            role="dialog"
            aria-label="Full screen table"
            testId="chat-table-fullscreen"
            tabIndex={-1}
            // biome-ignore lint/a11y/noAutofocus: a modal view takes focus on open, as the web's Radix dialog does, so Escape reaches it
            autoFocus
            style={FULLSCREEN}
            onKeyDown={(event: { key?: string }) => {
              if (event.key === 'escape') setOpen(false)
            }}
          >
            <div style={tw('flex items-center justify-end p-4')}>
              <IconActionGroup className="gap-1">
                <CopyAction code={source} disabled={streaming} />
                <DownloadAction code={source} language="md" disabled={streaming} />
                <IconActionButton label="Exit fullscreen" onClick={() => setOpen(false)}>
                  <X />
                </IconActionButton>
              </IconActionGroup>
            </div>
            <div style={tw('min-h-0 flex-1 px-4 pb-4 pt-0')}>
              <div style={tw('border border-border')}>{children}</div>
            </div>
          </div>
        </anchored>
      ) : null}
    </>
  )
}

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
          <TableFullscreen source={source} streaming={streaming}>
            {children}
          </TableFullscreen>
        </IconActionGroup>
      </div>
      <div style={tw('bg-background')}>{children}</div>
    </div>
  )
}
