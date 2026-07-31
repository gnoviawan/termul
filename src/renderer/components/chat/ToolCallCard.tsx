import { motion, useReducedMotion } from 'framer-motion'
import {
  AlertCircle,
  Brain,
  ChevronRight,
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
import { memo, useEffect, useRef, useState } from 'react'
import robotIconRaw from '@/assets/agent-icons/robot-01.svg?raw'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import type { ContentBlock, ToolCall, ToolCallContent } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import { MediaBlocks } from './ChatMessage'
import { bubbleEnter, CHAT_SPRING } from './chat-motion'
import { DiffPreview } from './DiffPreview'
import { type ToolIconName, toolIconName } from './tool-call-format'
import { describeToolCall, readableOutput } from './tool-call-summary'

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

function renderContentItem(
  item: ToolCallContent,
  key: number,
  toolCall: ToolCall
): React.JSX.Element {
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
    return c.content ? (
      renderContentBlock(c.content, key)
    ) : (
      <div key={key} className="text-xs italic text-muted-foreground">
        [content]
      </div>
    )
  }
  if (item.type === 'terminal') {
    const terminalId = (item as { terminalId?: string }).terminalId
    const output = typeof toolCall.terminalOutput === 'string' ? toolCall.terminalOutput : ''
    const exit = toolCall.terminalExitStatus as
      | { exitCode?: number | null; signal?: string | null }
      | null
      | undefined
    return (
      <div key={key} className="rounded border border-border/40 px-2 py-1 text-xs">
        <div className="text-muted-foreground">
          {terminalId ? `Terminal ${terminalId}` : 'Terminal'}
        </div>
        {output && <ResultBlock text={output} />}
        {toolCall.terminalTruncated && (
          <div className="mt-1 text-3xs text-amber-600 dark:text-amber-400">Output truncated</div>
        )}
        {exit && (
          <div className="mt-1 text-3xs text-muted-foreground">
            {exit.exitCode != null
              ? `Exit code ${exit.exitCode}`
              : exit.signal
                ? `Signal ${exit.signal}`
                : 'Exited'}
          </div>
        )}
      </div>
    )
  }
  return (
    <div key={key} className="text-xs italic text-muted-foreground">
      [{item.type}]
    </div>
  )
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
}

function ToolCallCardComponent({
  toolCall,
  animateEnter = true
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

  const row = (
    <>
      <Icon
        size={13}
        className={cn('shrink-0', failed ? 'text-red-400' : 'text-muted-foreground')}
      />
      <span className="min-w-0 flex-1 truncate" title={`${verb} ${primary}`.trim()}>
        {verb && <span className="text-muted-foreground">{verb} </span>}
        <span className={cn('font-medium', failed ? 'text-red-400' : 'text-foreground')}>
          {primary}
        </span>
      </span>
      {diffStat ? (
        <span className="shrink-0 text-3xs tabular-nums">
          <span className="text-green-700 dark:text-green-400">+{diffStat.added}</span>
          {diffStat.removed > 0 && (
            <span className="text-red-700 dark:text-red-400"> &minus;{diffStat.removed}</span>
          )}
        </span>
      ) : (
        detail && (
          <span className="shrink-0 text-3xs tabular-nums text-muted-foreground">{detail}</span>
        )
      )}
      {durationMs != null && (
        <span className="hidden shrink-0 text-3xs tabular-nums text-muted-foreground group-hover/tool:inline">
          {formatDuration(durationMs)}
        </span>
      )}
      {failed && <AlertCircle size={12} className="shrink-0 text-red-400" />}
      {hasDetail && (
        <motion.span
          aria-hidden="true"
          className="shrink-0 text-muted-foreground"
          animate={{ rotate: open ? 90 : 0 }}
          transition={reduced ? { duration: 0 } : CHAT_SPRING}
        >
          <ChevronRight size={13} />
        </motion.span>
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
        {hasDetail ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            data-press-feedback="off"
            className="flex min-h-7 w-full items-center gap-2 px-1 py-1 text-left text-xs outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {row}
          </button>
        ) : (
          <div className="flex min-h-7 items-center gap-2 px-1 py-1 text-xs">{row}</div>
        )}
        {hasDetail && (
          <CollapseExpandMotion open={open}>
            <div className="ml-4 flex flex-col gap-1.5 border-l border-border/50 px-2 pb-2 pt-1.5">
              {hasContent
                ? content.map((item, i) => renderContentItem(item, i, toolCall))
                : resultText && <ResultBlock text={resultText} />}
            </div>
          </CollapseExpandMotion>
        )}
      </div>
    </motion.div>
  )
}

export const ToolCallCard = memo(ToolCallCardComponent)
