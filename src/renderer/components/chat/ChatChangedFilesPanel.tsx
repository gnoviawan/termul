import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { CHAT_GUTTER_X, CHAT_HIT_MIN_H } from '@/components/chat/chat-layout'
import { describeToolCall, toolCallPath } from '@/components/chat/tool-call-summary'
import { ChevronDown, FileDiff } from '@/components/icons'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import type { ToolCall } from '@/lib/acp-api'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'
import { useEditorStore } from '@/stores/editor-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

/** A file touched by an ACP tool call in this session. */
interface ChangedFile {
  path: string
  toolCallId: string
  kind: string
  added: number
  removed: number
}

/** Extract file-changing tool calls (edit, delete, move) from the session's
 * tool-call list. Paths come from `toolCallPath` (locations → rawInput → diff
 * content). Add/remove counts come from `describeToolCall().diffStat` — the
 * same battle-tested path used by ToolCallCard. */
function extractChangedFiles(toolCalls: ToolCall[]): ChangedFile[] {
  const files: ChangedFile[] = []
  const seen = new Set<string>()
  for (const tc of toolCalls) {
    if (tc.kind !== 'edit' && tc.kind !== 'delete' && tc.kind !== 'move') continue
    const path = toolCallPath(tc)
    if (!path) continue
    const key = `${path}:${tc.toolCallId}`
    if (seen.has(key)) continue
    seen.add(key)
    const summary = describeToolCall(tc)
    const stat = summary.diffStat ?? { added: 0, removed: 0 }
    files.push({
      path,
      toolCallId: tc.toolCallId,
      kind: tc.kind ?? 'edit',
      added: stat.added,
      removed: stat.removed
    })
  }
  return files
}

function FileRow({
  file,
  cwd,
  onOpen
}: {
  file: ChangedFile
  cwd: string
  onOpen: (path: string) => void
}) {
  const normalized = file.path.replace(/\\/g, '/')
  const isAbsolute = /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('/')
  const fullPath = isAbsolute
    ? normalized
    : cwd
      ? `${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/${normalized.replace(/^\/+/, '')}`
      : file.path

  const hasCounts = file.added > 0 || file.removed > 0

  return (
    <button
      type="button"
      data-press-feedback="off"
      onClick={() => onOpen(fullPath)}
      className={cn(
        'group/row flex w-full items-center gap-2 rounded-md px-3 text-left',
        CHAT_HIT_MIN_H,
        'cursor-pointer select-none transition-[background-color,color] duration-150 ease-out motion-reduce:transition-none',
        'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
        'active:bg-secondary/80',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'
      )}
    >
      <FileDiff size={13} className="shrink-0 text-diff-modified" aria-hidden />
      <span
        className="min-w-0 flex-1 truncate text-2xs font-medium leading-tight"
        title={normalized}
      >
        {normalized}
      </span>
      {hasCounts && (
        <span className="shrink-0 font-mono text-2xs leading-tight">
          <span className="text-success">+{file.added}</span>{' '}
          <span className="text-destructive">−{file.removed}</span>
        </span>
      )}
    </button>
  )
}

interface ChatChangedFilesPanelProps {
  cwd: string
  toolCalls: ToolCall[]
}

/**
 * Collapsible, scrollable "Changed files" panel anchored on top of the
 * ChatInputBar. Lists files touched by ACP tool calls (edit/delete/move) in
 * the current session — persists across agent replies. Clicking a file row
 * opens it in the editor workspace. View-and-open-only.
 *
 * The panel sits behind the chatbox (z-0 vs z-10). A negative bottom margin
 * extends the panel's translucent bg-card/60 behind the chatbox's rounded top
 * corners, covering the transparent gap. The visible content has bottom
 * padding so text clears the overlap zone.
 */
export function ChatChangedFilesPanel({
  cwd,
  toolCalls
}: ChatChangedFilesPanelProps): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)

  const files = useMemo(() => extractChangedFiles(toolCalls), [toolCalls])
  const count = files.length
  const totalAdded = useMemo(() => files.reduce((sum, f) => sum + f.added, 0), [files])
  const totalRemoved = useMemo(() => files.reduce((sum, f) => sum + f.removed, 0), [files])
  const hasTotalCounts = totalAdded > 0 || totalRemoved > 0

  const handleOpenFile = useCallback(async (fullPath: string) => {
    try {
      await useEditorStore.getState().openFile(fullPath)
      useWorkspaceStore.getState().addEditorTab(fullPath)
    } catch (error) {
      toast.error('Could not open file')
      void logFrontendError({
        level: 'warn',
        message: `ChatChangedFilesPanel: openFile failed for ${fullPath}: ${String(error)}`,
        source: 'ChatChangedFilesPanel'
      })
    }
  }, [])

  if (count === 0) return null

  return (
    <div className={cn(CHAT_GUTTER_X, '-mb-6 pt-0')}>
      <div className="relative mx-auto w-full max-w-3xl">
        <div className="relative z-0 overflow-hidden rounded-t-2xl border border-b-0 border-border/60 bg-card/60 select-none">
          <button
            type="button"
            data-press-feedback="off"
            onClick={() => setExpanded((v) => !v)}
            className={cn(
              'flex w-full items-center gap-2 rounded-t-2xl px-3 text-left',
              CHAT_HIT_MIN_H,
              expanded ? 'py-2' : 'pt-2 pb-8',
              'cursor-pointer text-xs text-muted-foreground',
              'select-none appearance-none transition-[background-color,color] duration-150 ease-out',
              'hover:bg-secondary/60 hover:text-foreground',
              'active:bg-secondary/80',
              'focus-visible:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none'
            )}
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse changed files' : 'Expand changed files'}
          >
            <ChevronDown
              size={14}
              className={cn(
                'shrink-0 transition-transform duration-[var(--acc-chevron)] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                expanded ? 'rotate-180' : 'rotate-0'
              )}
            />
            <FileDiff size={13} className="shrink-0 text-muted-foreground/70" />
            <span className="font-medium">Changed files</span>
            <span className="rounded-full bg-secondary px-1.5 py-0.5 text-3xs font-semibold tabular-nums">
              {count}
            </span>
            {hasTotalCounts && (
              <span className="ms-auto shrink-0 font-mono text-2xs tabular-nums">
                <span className="text-success">+{totalAdded}</span>{' '}
                <span className="text-destructive">−{totalRemoved}</span>
              </span>
            )}
          </button>
          <CollapseExpandMotion open={expanded} motion="chat">
            <div className="pb-6">
              <div className="scroller-thin max-h-48 overflow-y-auto">
                <div className="space-y-0.5 p-1">
                  {files.map((file) => (
                    <FileRow
                      key={`${file.path}:${file.toolCallId}`}
                      file={file}
                      cwd={cwd}
                      onOpen={handleOpenFile}
                    />
                  ))}
                </div>
              </div>
            </div>
          </CollapseExpandMotion>
        </div>
      </div>
    </div>
  )
}
