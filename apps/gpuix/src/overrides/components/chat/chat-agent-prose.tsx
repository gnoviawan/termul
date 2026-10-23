/**
 * GPUIX override of `components/chat/chat-agent-prose.tsx`.
 *
 * The web renders a reply through Streamdown: DOM markdown with custom
 * components, Shiki code blocks and Mermaid. Here a reply becomes parts
 * (`proseParts`): top-level fences go to the code card, and each prose piece
 * becomes one native `<markdown>` per top-level block, spaced with the web
 * stylesheet's collapsed margins. Only the streaming tail block changes while
 * a reply grows, so settled blocks keep their native layout.
 *
 * Kept from the web: the 10 Hz streaming throttle, incomplete-markdown repair
 * while streaming (`remend`, what Streamdown's `parseIncompleteMarkdown` runs),
 * file links that open in the editor, external links behind a confirm dialog,
 * and stand-alone images. Mermaid shows its source with a note.
 */

import { memo, type ReactNode, useCallback, useMemo, useState } from 'react'
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
import { CodeCard } from '../../../chat/CodeCard'
import { type FlowBlock, flowGap } from '../../../chat/prose-flow'
import { type ProsePart, proseParts } from '../../../chat/prose-parts'
import { fileLinkPath, proseBlocks } from '../../../chat/prose-source'
import { transcriptThemes } from '../../../chat/theme'
import { tw } from '../../../style/tw'

type Row =
  | { key: string; kind: 'markdown'; source: string; flow: FlowBlock }
  | { key: string; kind: 'image'; url: string; alt: string; flow: FlowBlock }
  | { key: string; kind: 'fence'; part: Extract<ProsePart, { kind: 'fence' }>; flow: FlowBlock }

/** Every block of a reply in paint order, with the margins its web twin has. */
function replyRows(text: string, streaming: boolean, linkFiles: boolean): Row[] {
  const parts = proseParts(text)
  const rows: Row[] = []
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
        rows.push({ key, kind: 'image', url: block.url, alt: block.alt, flow: { kind: 'paragraph' } })
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
  return rows
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

function openFile(path: string, context: FilePathResolutionContext): void {
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
    <div
      testId="termul-file-path"
      style={{ ...tw('cursor-pointer'), alignSelf: 'flex-start' }}
      onClick={() => openFile(path, context)}
    >
      {typeof children === 'string' ? (
        <text style={tw('font-medium text-primary underline')}>{children}</text>
      ) : (
        children
      )}
    </div>
  )
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

const MarkdownBlock = memo(function MarkdownBlock({
  source,
  marginTop,
  onLink
}: {
  source: string
  marginTop: number
  onLink: (url: string) => void
}) {
  const themes = transcriptThemes(useColorTheme())
  return (
    <markdown
      source={source}
      theme={themes.prose}
      style={{ marginTop, minWidth: 0 }}
      onLinkClick={(event) => {
        if (event.value) onLink(event.value)
      }}
    />
  )
})

/** Agent reply rendered as native markdown blocks. */
export function AgentProse({
  text: rawText,
  streaming,
  filePathContext
}: {
  text: string
  streaming: boolean
  reduced: boolean
  filePathContext?: FilePathResolutionContext
}) {
  const text = useThrottledStreamingText(rawText, streaming)
  const [externalUrl, setExternalUrl] = useState<string | null>(null)
  const rows = useMemo(
    () => replyRows(text, streaming, filePathContext !== undefined),
    [text, streaming, filePathContext]
  )
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

  return (
    <div style={tw('flex min-w-0 flex-col text-sm leading-normal text-foreground')} testId="agent-prose">
      {rows.map((row, i) => {
        const marginTop = i === 0 ? 0 : flowGap(rows[i - 1].flow, row.flow)
        if (row.kind === 'fence') {
          return (
            <div key={row.key} style={{ marginTop }}>
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
            <div key={row.key} style={{ marginTop }}>
              <TermulMarkdownImage url={row.url} alt={row.alt} cwd={filePathContext?.cwd} />
            </div>
          )
        }
        return <MarkdownBlock key={row.key} source={row.source} marginTop={marginTop} onLink={onLink} />
      })}
      {externalUrl ? <LinkSafetyDialog url={externalUrl} onClose={() => setExternalUrl(null)} /> : null}
    </div>
  )
}
