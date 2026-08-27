import { ChevronDown, FileDiff, GitBranch } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { CHAT_GUTTER_X } from '@/components/chat/chat-layout'
import { toolCallPath } from '@/components/chat/tool-call-summary'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ScrollArea } from '@/components/ui/scroll-area'
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
    files.push({ path, toolCallId: tc.toolCallId, kind: tc.kind ?? 'edit' })
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
  const fileName = normalized.split('/').pop() || file.path
  const dirName = normalized.includes('/')
    ? normalized.substring(0, normalized.lastIndexOf('/'))
    : ''
  const isAbsolute = /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('/')
  const fullPath = isAbsolute
    ? normalized
    : cwd
      ? `${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/${normalized.replace(/^\/+/, '')}`
      : file.path

  return (
    <button
      type="button"
      onClick={() => onOpen(fullPath)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(fullPath)
        }
      }}
      className={cn(
        'group/row flex w-full items-center gap-2 px-3 py-1.5 rounded-md cursor-pointer',
        'hover:bg-secondary/80 text-muted-foreground hover:text-foreground transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60'
      )}
    >
      <FileDiff size={13} className="shrink-0 text-amber-500" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-2xs font-medium leading-tight">
        {dirName ? `${dirName}/${fileName}` : fileName}
      </span>
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
 */
export function ChatChangedFilesPanel({
  cwd,
  toolCalls
}: ChatChangedFilesPanelProps): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)

  const files = useMemo(() => extractChangedFiles(toolCalls), [toolCalls])
  const count = files.length

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
    <div className={cn(CHAT_GUTTER_X, '-mb-1 pt-1')}>
      <div className="relative mx-auto w-full max-w-3xl">
        <Collapsible open={expanded} onOpenChange={setExpanded}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className={cn(
                'relative z-0 flex w-full min-w-0 items-center gap-2',
                'rounded-t-2xl border border-b-0 border-border/60 bg-card/60 px-3 py-1.5',
                'text-xs text-muted-foreground transition-colors',
                'hover:bg-secondary/40 hover:text-foreground'
              )}
              aria-label={expanded ? 'Collapse changed files' : 'Expand changed files'}
            >
              <ChevronDown
                size={14}
                className={cn(
                  'shrink-0 transition-transform',
                  expanded ? 'rotate-180' : 'rotate-0'
                )}
              />
              <GitBranch size={13} className="shrink-0 text-muted-foreground/70" />
              <span className="font-medium">Changed files</span>
              <span className="ml-1 rounded-full bg-secondary px-1.5 py-0.5 text-3xs font-semibold">
                {count}
              </span>
              <FileDiff
                size={12}
                className="ml-auto shrink-0 text-muted-foreground/50"
                aria-hidden
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="relative z-0 w-full min-w-0 rounded-b-2xl border border-t-0 border-border/60 bg-card/60">
              <ScrollArea className="max-h-48 w-full">
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
              </ScrollArea>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  )
}
