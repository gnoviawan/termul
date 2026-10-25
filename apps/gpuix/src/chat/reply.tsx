/**
 * One agent reply as native rows: the parts and blocks of `proseParts` /
 * `proseBlocks`, each painted by `ReplyBlock` with its web margin. Two hosts
 * use it: `AgentProse` (all blocks in one column, wherever a reply renders)
 * and the transcript, which gives every block its own `<virtual-list>` row so
 * GPUI lays out only the blocks near the viewport while a reply streams.
 *
 * Kept from the web: the 10 Hz streaming throttle, incomplete-markdown repair
 * while streaming (`remend`, what Streamdown's `parseIncompleteMarkdown`
 * runs), file links that open in the editor, external links behind a confirm
 * dialog, and stand-alone images. Mermaid shows its source with a note.
 */

import { memo, type ReactNode, useCallback, useLayoutEffect, useMemo, useState } from 'react'
import remend from 'remend'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { useThrottledStreamingText } from '@/hooks/use-throttled-streaming-text'
import { openerApi } from '@/lib/api'
import { type FilePathResolutionContext, openFilePathFromTerminal } from '@/lib/file-path-links'
import { logFrontendError } from '@/lib/log-api'
import { useColorTheme } from '@/stores/app-settings-store'
import { tw } from '../style/tw'
import { CodeCard } from './CodeCard'
import { transcriptProbe } from './perf-probe'
import { type FlowBlock, flowGap, leadingMargin } from './prose-flow'
import { type ProsePart, proseParts } from './prose-parts'
import { fileLinkPath, listItems, proseBlocks, taskMarker, unquote } from './prose-source'
import { TableCard } from './TableCard'
import { TaskItem } from './TaskItem'
import { transcriptThemes } from './theme'

export type ReplyRow =
  | { key: string; kind: 'markdown'; source: string; flow: FlowBlock }
  | { key: string; kind: 'image'; url: string; alt: string; flow: FlowBlock }
  | { key: string; kind: 'fence'; part: Extract<ProsePart, { kind: 'fence' }>; flow: FlowBlock }

/**
 * Streamdown's `caret="block"`: ` ▋` as `::after` content of the reply's last
 * block while it streams. After a paragraph or heading it runs on in the
 * text; after other blocks it would sit on a line of its own, so those keep
 * none here.
 */
const STREAM_CARET = ' \u258B'
const INLINE_CARET: ReadonlySet<FlowBlock['kind']> = new Set(['paragraph', 'heading'])

/** Every block of a reply in paint order, with the margins its web twin has. */
function replyRows(text: string, streaming: boolean, linkFiles: boolean): ReplyRow[] {
  const parts = proseParts(text)
  const rows: ReplyRow[] = []
  parts.forEach((part, index) => {
    if (part.kind === 'fence') {
      rows.push({ key: part.key, kind: 'fence', part, flow: { kind: 'fence' } })
      return
    }
    const tail = streaming && index === parts.length - 1
    const blocks = proseBlocks(tail ? remend(part.source) : part.source, linkFiles)
    blocks.forEach((block, b) => {
      const key = `${part.key}.${b}`
      if (block.kind === 'image') {
        rows.push({
          key,
          kind: 'image',
          url: block.url,
          alt: block.alt,
          flow: { kind: 'paragraph' }
        })
      } else {
        rows.push({
          key,
          kind: 'markdown',
          source: block.source,
          flow: { kind: block.block, depth: block.depth }
        })
      }
    })
  })
  const last = rows.at(-1)
  if (streaming && last?.kind === 'markdown' && INLINE_CARET.has(last.flow.kind)) {
    last.source += STREAM_CARET
  }
  return rows
}

/** The reply's rows for its current text, throttled while it streams like the web's. */
export function useReplyRows(rawText: string, streaming: boolean, linkFiles: boolean): ReplyRow[] {
  const text = useThrottledStreamingText(rawText, streaming)
  useLayoutEffect(() => {
    if (streaming) transcriptProbe.onStreamCommit?.(text)
  }, [text, streaming])
  return useMemo(() => replyRows(text, streaming, linkFiles), [text, streaming, linkFiles])
}

/** The margin above row `index`, from the web's collapsed block margins. */
export function rowMargin(rows: readonly ReplyRow[], index: number): number {
  return index === 0 ? leadingMargin(rows[0].flow) : flowGap(rows[index - 1].flow, rows[index].flow)
}

const ALT_CHIP = tw(
  'flex max-w-[16rem] items-center self-start rounded border border-border/40 bg-muted/40 px-1.5 py-0.5 text-xs text-muted-foreground'
)

/** Muted fallback for images we cannot render. */
function TermulImageAltChip({ alt }: { alt: string }) {
  return (
    <div style={ALT_CHIP} testId="termul-image-alt">
      <text style={{ ...tw('truncate text-xs text-muted-foreground') }}>{alt || 'image'}</text>
    </div>
  )
}

/**
 * Renders a markdown image. `data:` URLs and remote URLs paint natively;
 * `file://` and relative paths need the brokered attachment read, which the
 * web gates to Tauri too, so they fall back to the alt chip.
 */
export function TermulMarkdownImage({ url, alt }: { url: string; alt: string; cwd?: string }) {
  if (!/^(data:|https?:)/i.test(url)) return <TermulImageAltChip alt={alt} />
  return (
    <img
      src={url}
      alt={alt}
      objectFit="contain"
      style={{ ...tw('max-w-full rounded-md'), width: 384, height: 384 }}
    />
  )
}

export function openFile(path: string, context: FilePathResolutionContext): void {
  void openFilePathFromTerminal(path, context)
    .then((result) => {
      if (!result.ok) toast.error(result.message)
    })
    .catch((error: unknown) => {
      void logFrontendError({
        level: 'warn',
        source: 'ChatMessage.filePathLink',
        message: `Failed to open ${path}: ${String(error)}`
      })
      toast.error('Failed to open file from chat.')
    })
}

function LinkSafetyDialog({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <AlertDialog
      open
      onOpenChange={(open: boolean) => {
        if (!open) onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Open external link?</AlertDialogTitle>
          <AlertDialogDescription className="break-all">{url}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              void openerApi.openUrlWithSystemBrowser(url)
              onClose()
            }}
          >
            Open
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Link clicks of a reply: files open in the editor, external URLs ask first. */
export function useReplyLinks(filePathContext: FilePathResolutionContext | undefined): {
  onLink: (url: string) => void
  dialog: ReactNode
} {
  const [externalUrl, setExternalUrl] = useState<string | null>(null)
  const onLink = useCallback(
    (url: string) => {
      const path = fileLinkPath(url)
      if (path !== null) {
        if (filePathContext) openFile(path, filePathContext)
        return
      }
      if (url.startsWith('#')) {
        void logFrontendError({
          level: 'info',
          source: 'ChatMessage.anchorLink',
          message: `In-message anchors do not scroll in the GPUIX transcript; ignoring '${url}'`
        })
        return
      }
      setExternalUrl(url)
    },
    [filePathContext]
  )
  const dialog = externalUrl ? (
    <LinkSafetyDialog url={externalUrl} onClose={() => setExternalUrl(null)} />
  ) : null
  return { onLink, dialog }
}

/** Streamdown's `li` `py-1`. */
const LIST_ITEM_PAD = 4
/** `.chat-streamdown` lists: `padding-left: 1.25rem`; items `py-1` (see `listItems`). */
const LIST_BOX = {
  display: 'flex' as const,
  flexDirection: 'column' as const,
  gap: LIST_ITEM_PAD * 2,
  paddingLeft: 20,
  paddingTop: LIST_ITEM_PAD,
  paddingBottom: LIST_ITEM_PAD,
  minWidth: 0
}

/**
 * Streamdown's quote, `border-l-4 border-muted-foreground/30 pl-4
 * text-muted-foreground`: its utilities beat `.chat-streamdown`'s 2px rule
 * (components layer). Native markdown paints quotes as a tinted card, so the
 * rule is drawn here around the quote's own content.
 */
const QUOTE = { ...tw('border-l-4 border-muted-foreground/30 pl-4'), minWidth: 0 }

const MarkdownBlock = memo(function MarkdownBlock({
  source,
  block,
  marginTop,
  streaming,
  onLink
}: {
  source: string
  block: FlowBlock['kind']
  marginTop: number
  streaming: boolean
  onLink: (url: string) => void
}) {
  const themeId = useColorTheme()
  const themes = transcriptThemes(themeId)
  const quote = block === 'blockquote'
  const native = (text: string, key?: number) => (
    <markdown
      key={key}
      source={text}
      theme={quote ? themes.quote : themes.prose}
      style={{ minWidth: 0 }}
      onLinkClick={(event) => {
        if (event.value) onLink(event.value)
      }}
    />
  )
  const markdown =
    block === 'list' ? (
      <div style={LIST_BOX}>
        {listItems(source).map((item, i) => {
          const task = taskMarker(item)
          return task ? (
            <TaskItem key={i} task={task} themeId={themeId}>
              {native(task.body)}
            </TaskItem>
          ) : (
            native(item, i)
          )
        })}
      </div>
    ) : (
      native(quote ? unquote(source) : source)
    )
  return (
    <div style={{ marginTop, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      {block === 'table' ? (
        <TableCard source={source} streaming={streaming}>
          {markdown}
        </TableCard>
      ) : quote ? (
        <div style={QUOTE}>{markdown}</div>
      ) : (
        markdown
      )}
    </div>
  )
})

/** One row of a reply: a code card, an image, or a markdown block. */
export const ReplyBlock = memo(function ReplyBlock({
  row,
  marginTop,
  streaming,
  onLink,
  cwd
}: {
  row: ReplyRow
  marginTop: number
  streaming: boolean
  onLink: (url: string) => void
  cwd?: string
}) {
  if (row.kind === 'fence') {
    return (
      <div style={{ marginTop }}>
        <CodeCard
          code={row.part.code}
          language={row.part.language}
          open={row.part.open}
          streaming={streaming}
        />
      </div>
    )
  }
  if (row.kind === 'image') {
    return (
      <div style={{ marginTop }}>
        <TermulMarkdownImage url={row.url} alt={row.alt} cwd={cwd} />
      </div>
    )
  }
  return (
    <MarkdownBlock
      source={row.source}
      block={row.flow.kind}
      marginTop={marginTop}
      streaming={streaming}
      onLink={onLink}
    />
  )
})
