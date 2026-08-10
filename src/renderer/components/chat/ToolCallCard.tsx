import { motion, useReducedMotion } from 'framer-motion'
import {
  AlertCircle,
  Brain,
  ChevronRight,
  ExternalLink,
  FilePen,
  FileText,
  FolderInput,
  Globe,
  Search,
  Shuffle,
  TerminalSquare,
  Trash2,
  Wrench
} from 'lucide-react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import robotIconRaw from '@/assets/agent-icons/robot-01.svg?raw'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import { IconActionButton } from '@/components/ui/icon-action-button'
import type { ContentBlock, ToolCall, ToolCallContent } from '@/lib/acp-api'
import { type FilePathResolutionContext, openFilePathFromTerminal } from '@/lib/file-path-links'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'
import { MediaBlocks } from './ChatMessage'
import { bubbleEnter, CHEVRON_TRANSITION } from './chat-motion'
import { DiffPreview } from './DiffPreview'
import { type ToolIconName, toolIconName } from './tool-call-format'
import {
  describeToolCall,
  firstString,
  PATH_KEYS,
  READABLE_TEXT_KEYS,
  readableOutput
} from './tool-call-summary'

/** Common prop shape shared by lucide icons and the bundled RobotIcon. */
type ToolIconComponent = React.ComponentType<{ size?: number | string; className?: string }>

/** Inner markup of the bundled robot SVG (drops the outer <svg> wrapper). */
const ROBOT_INNER = robotIconRaw.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')

/** Robot glyph for subagent/Task calls, matching the lucide icon prop shape. */
function RobotIcon({
  size = 24,
  className
}: {
  size?: number | string
  className?: string
}): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      className={className}
      aria-hidden="true"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: bundled static asset
      dangerouslySetInnerHTML={{ __html: ROBOT_INNER }}
    />
  )
}

const ICONS: Record<ToolIconName, ToolIconComponent> = {
  read: FileText,
  edit: FilePen,
  delete: Trash2,
  move: FolderInput,
  search: Search,
  execute: TerminalSquare,
  think: Brain,
  fetch: Globe,
  switch: Shuffle,
  agent: RobotIcon,
  tool: Wrench
}

function renderContentBlock(block: ContentBlock, key: number): React.JSX.Element {
  if (block.type === 'text') {
    return (
      <div key={key} className="whitespace-pre-wrap break-words text-xs text-foreground/90">
        {block.text ?? ''}
      </div>
    )
  }
  return <MediaBlocks key={key} blocks={[block]} />
}

/**
 * Best-effort extraction of a readable string from an unrecognized
 * ToolCallContent item. Tries common text keys directly, then one level of
 * nesting (e.g. { output: { text: '...' } }). Returns null when nothing is
 * found so the caller can render nothing instead of a bracketed type label.
 * Shares `READABLE_TEXT_KEYS` + `firstString` with `readableOutput` to prevent
 * drift between the structured-content and raw-output extraction paths.
 */
function extractItemText(item: ToolCallContent): string | null {
  const record = item as Record<string, unknown>
  const direct = firstString(record, READABLE_TEXT_KEYS)
  if (direct) return direct
  for (const k of READABLE_TEXT_KEYS) {
    const v = record[k]
    if (v && typeof v === 'object') {
      const nested = firstString(v as Record<string, unknown>, READABLE_TEXT_KEYS)
      if (nested) return nested
    }
  }
  return null
}

function renderContentItem(item: ToolCallContent, key: number): React.JSX.Element | null {
  if (item.type === 'diff') {
    const d = item as { path: string; oldText?: string | null; newText: string }
    return (
      <DiffPreview
        key={key}
        diff={{ path: d.path, oldText: d.oldText ?? null, newText: d.newText }}
      />
    )
  }
  if (item.type === 'content') {
    const c = item as { content?: ContentBlock }
    return c.content ? renderContentBlock(c.content, key) : null
  }
  if (item.type === 'terminal') {
    // The ACP `terminal` content variant only references a terminal by id; its
    // live output is fetched separately via `terminal/output` (not embedded in
    // the tool call), so we surface the reference rather than inline output.
    const terminalId = (item as { terminalId?: string }).terminalId
    return (
      <div
        key={key}
        className="rounded border border-border/40 px-2 py-1 text-xs text-muted-foreground"
      >
        {terminalId ? `Terminal ${terminalId}` : 'Terminal'}
      </div>
    )
  }
  // Unrecognized content type: try to surface any readable text the item
  // carries before giving up. Never render the raw type name as a bracketed
  // label — that leaks internal names into the chat UI.
  const text = extractItemText(item)
  if (text) {
    return (
      <div key={key} className="whitespace-pre-wrap break-words text-xs text-foreground/90">
        {text}
      </div>
    )
  }
  return null
}

/** Human-friendly elapsed time for a settled tool call. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 1000)}s`
}

/** Readable tool result text (e.g. command output, search hits, a diff/patch). */
function ResultBlock({ text }: { text: string }): React.JSX.Element {
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border/40 bg-background/60 px-2 py-1.5 font-mono text-xs leading-relaxed text-foreground/90">
      {text}
    </pre>
  )
}

interface ToolCallCardProps {
  toolCall: ToolCall
  /** Play enter animation only for newly arrived tool calls. */
  animateEnter?: boolean
  /** Filesystem roots used to resolve an "Open file" action on file tool calls. */
  filePathContext?: FilePathResolutionContext
}

/** Kinds whose `rawInput` carries a file path worth offering to open in the editor. */
const FILE_OPEN_KINDS = new Set(['read', 'edit', 'delete', 'move'])

/**
 * Best-effort extraction of a file path from a tool call's `rawInput`, using
 * the shared `PATH_KEYS` set so the chip's primary path and the open-file
 * button stay in sync. Returns undefined when no path-like field is present.
 */
function toolCallFilePath(toolCall: ToolCall): string | undefined {
  if (!FILE_OPEN_KINDS.has(toolCall.kind ?? '')) return undefined
  const input =
    toolCall.rawInput && typeof toolCall.rawInput === 'object'
      ? (toolCall.rawInput as Record<string, unknown>)
      : null
  return firstString(input, PATH_KEYS) ?? undefined
}

function ToolCallCardComponent({
  toolCall,
  animateEnter = true,
  filePathContext
}: ToolCallCardProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const Icon = ICONS[toolIconName(toolCall)]
  const content = toolCall.content ?? []
  const hasContent = content.length > 0
  // Show the readable RESULT only — never the raw input or the JSON envelope.
  // Structured content (diffs/text) is canonical; otherwise extract the output.
  const resultText = hasContent ? '' : readableOutput(toolCall.rawOutput)
  const hasDetail = hasContent || resultText.length > 0
  const status = toolCall.status
  const inProgress = status === 'in_progress'
  const failed = status === 'failed'

  // Collapsed by default for a clean, scannable list; a click reveals details.
  // Settle time is stamped only on an observed transition, so history-loaded
  // cards never show a bogus duration.
  const [open, setOpen] = useState(false)
  const [endedAt, setEndedAt] = useState<number | null>(null)
  const prevStatus = useRef(status)
  useEffect(() => {
    if (prevStatus.current === status) return
    if (status === 'completed' || status === 'failed') setEndedAt(Date.now())
    prevStatus.current = status
  }, [status])

  const startedAt = typeof toolCall.timestamp === 'number' ? toolCall.timestamp : null
  const durationMs = endedAt != null && startedAt != null ? endedAt - startedAt : null

  const { verb, primary, detail, diffStat } = describeToolCall(toolCall)
  const enter = bubbleEnter('neutral', reduced)

  const openFilePath = filePathContext ? toolCallFilePath(toolCall) : undefined
  const openFile = useCallback(() => {
    if (!openFilePath || !filePathContext) return
    void openFilePathFromTerminal(openFilePath, filePathContext)
      .then((result) => {
        if (!result.ok) toast.error(result.message)
      })
      .catch((error: unknown) => {
        void logFrontendError({
          level: 'warn',
          source: 'ToolCallCard.openFile',
          message: `Failed to open ${openFilePath}: ${String(error)}`
        })
        toast.error('Failed to open file from chat.')
      })
  }, [openFilePath, filePathContext])

  // Row summary (icon + label + meta) lives inside the disclosure button so
  // clicking the label toggles details. The open-file button and chevron are
  // rendered as siblings outside the disclosure button — nesting a <button>
  // inside the disclosure <button> is invalid HTML, so they stay at the row
  // level. Visual order (icon, label, meta/diffStat, open-file, duration,
  // alert, chevron) is preserved by the flex container below.
  const rowSummary = (
    <>
      <Icon
        size={13}
        className={cn('shrink-0', failed ? 'text-destructive' : 'text-muted-foreground')}
      />
      <span className="min-w-0 flex-1 truncate" title={`${verb} ${primary}`.trim()}>
        {verb && <span className="text-muted-foreground">{verb} </span>}
        <span className={cn('font-medium', failed ? 'text-destructive' : 'text-foreground')}>
          {primary}
        </span>
      </span>
      {diffStat ? (
        <span className="shrink-0 text-3xs tabular-nums">
          <span className="text-success">+{diffStat.added}</span>
          {diffStat.removed > 0 && (
            <span className="text-destructive"> &minus;{diffStat.removed}</span>
          )}
        </span>
      ) : (
        detail && (
          <span className="shrink-0 text-3xs tabular-nums text-muted-foreground">{detail}</span>
        )
      )}
    </>
  )

  return (
    <motion.div
      aria-busy={inProgress || undefined}
      data-status={status}
      className={cn(
        'group/tool relative my-0.5 w-full overflow-hidden',
        inProgress && 'tool-call-card-running'
      )}
      initial={animateEnter ? enter.initial : false}
      animate={enter.animate}
      transition={enter.transition}
    >
      <div className="relative z-10">
        <div className="flex min-h-7 items-center gap-2 px-1 py-1 text-xs">
          {hasDetail ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              data-press-feedback="off"
              className="flex min-h-7 min-w-0 flex-1 items-center gap-2 text-left text-xs outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {rowSummary}
            </button>
          ) : (
            <div className="flex min-h-7 min-w-0 flex-1 items-center gap-2 text-xs">
              {rowSummary}
            </div>
          )}
          {openFilePath ? (
            <IconActionButton label="Open file" onClick={openFile} size="sm">
              <ExternalLink />
            </IconActionButton>
          ) : null}
          {durationMs != null && (
            <span className="hidden shrink-0 text-3xs tabular-nums text-muted-foreground group-hover/tool:inline">
              {formatDuration(durationMs)}
            </span>
          )}
          {failed && <AlertCircle size={12} className="shrink-0 text-destructive" />}
          {hasDetail && (
            <motion.span
              aria-hidden="true"
              className="shrink-0 text-muted-foreground"
              animate={{ rotate: open ? 90 : 0 }}
              transition={reduced ? { duration: 0 } : CHEVRON_TRANSITION}
            >
              <ChevronRight size={13} />
            </motion.span>
          )}
        </div>
        {hasDetail && (
          <CollapseExpandMotion open={open}>
            <div className="ml-4 flex flex-col gap-1.5 border-l border-border/50 px-2 pb-2 pt-1.5">
              {hasContent
                ? content.map((item, i) => renderContentItem(item, i))
                : resultText && <ResultBlock text={resultText} />}
            </div>
          </CollapseExpandMotion>
        )}
      </div>
    </motion.div>
  )
}

export const ToolCallCard = memo(ToolCallCardComponent)
