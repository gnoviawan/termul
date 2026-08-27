import { ChevronDown, FileDiff } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { CHAT_GUTTER_X } from '@/components/chat/chat-layout'
import { diffLineCounts } from '@/components/chat/tool-call-format'
import { toolCallPath } from '@/components/chat/tool-call-summary'
import type { ToolCall, ToolCallContent } from '@/lib/acp-api'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'
import { useEditorStore } from '@/stores/editor-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

const COLLAPSE_TRANSITION = 'transition-[max-height,opacity] duration-150 ease-in-out'

/** A file touched by an ACP tool call in this session. */
interface ChangedFile {
  path: string
  toolCallId: string
  kind: string
  added: number
  removed: number
}

/** Compute add/remove line counts from a tool call's diff content items. */
function diffCounts(content: ToolCallContent[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const item of content) {
    if (item.type === 'diff') {
      const d = item as { path?: string; oldText?: string | null; newText: string }
      const counts = diffLineCounts({ oldText: d.oldText ?? null, newText: d.newText ?? '' })
      added += counts.added
      removed += counts.removed
    }
  }
  return { added, removed }
}

/** Extract file-changing tool calls (edit, delete, move) from the session's
 * tool-call list. Paths come from `toolCallPath` (rawInput + diff content). */
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
    const { added, removed } = diffCounts(tc.content ?? [])
    files.push({ path, toolCallId: tc.toolCallId, kind: tc.kind ?? 'edit', added, removed })
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpen(fullPath)
    }
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: div avoids browser button width-shrink
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(fullPath)}
      onKeyDown={handleKeyDown}
      className={cn(
        'group/row flex w-full items-center gap-2 px-3 py-1.5 rounded-md cursor-pointer text-left',
        'select-none transition-colors duration-100',
        'hover:bg-secondary/60 text-muted-foreground hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60'
      )}
    >
      <FileDiff size={13} className="shrink-0 text-amber-500" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-2xs font-medium leading-tight">
        {normalized}
      </span>
      {hasCounts && (
        <span className="shrink-0 font-mono text-3xs leading-tight">
          <span className="text-success">+{file.added}</span>{' '}
          <span className="text-destructive">−{file.removed}</span>
        </span>
      )}
    </div>
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
 * extends the panel's opaque bg-card behind the chatbox's rounded top corners,
 * covering the transparent gap. The visible content has bottom padding so text
 * clears the overlap zone.
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

  const handleToggleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setExpanded((v) => !v)
    }
  }

  return (
    <div className={cn(CHAT_GUTTER_X, '-mb-5 pt-0')}>
      <div className="relative mx-auto w-full max-w-3xl">
        <div className="relative z-0 rounded-t-2xl border border-b-0 border-border/60 bg-card select-none">
          {/* biome-ignore lint/a11y/useSemanticElements: div avoids browser button width-shrink */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => setExpanded((v) => !v)}
            onKeyDown={handleToggleKeyDown}
            className={cn(
              'flex w-full items-center gap-2 px-3 pb-5 pt-2',
              'cursor-pointer text-xs text-muted-foreground',
              'select-none transition-colors duration-100',
              'hover:bg-secondary/40 hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60'
            )}
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse changed files' : 'Expand changed files'}
          >
            <ChevronDown
              size={14}
              className={cn(
                'shrink-0 transition-transform duration-150',
                expanded ? 'rotate-180' : 'rotate-0'
              )}
            />
            <FileDiff size={13} className="shrink-0 text-muted-foreground/70" />
            <span className="font-medium">Changed files</span>
            <span className="ml-1 rounded-full bg-secondary px-1.5 py-0.5 text-3xs font-semibold">
              {count}
            </span>
            <span className="ml-auto shrink-0 font-mono text-3xs">
              <span className="text-success">+{totalAdded}</span>{' '}
              <span className="text-destructive">−{totalRemoved}</span>
            </span>
          </div>
          <div
            className={cn(
              'overflow-hidden',
              expanded ? 'max-h-48 opacity-100' : 'max-h-0 opacity-0',
              COLLAPSE_TRANSITION
            )}
          >
            <div className="pb-5">
              <div className="max-h-48 overflow-y-auto">
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
          </div>
        </div>
      </div>
    </div>
  )
}
