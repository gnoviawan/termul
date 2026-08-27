import type { GitStatusDetail } from '@shared/types/ipc.types'
import { ChevronDown, GitBranch } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { CHAT_GUTTER_X } from '@/components/chat/chat-layout'
import { GitStatusBadge } from '@/components/git/git-status-badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ScrollArea } from '@/components/ui/scroll-area'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'
import { useEditorStore } from '@/stores/editor-store'
import { useGitStatusStore } from '@/stores/git-status-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

const REFRESH_INTERVAL_MS = 3000

/** Stable empty array so the Zustand selector never returns a new reference
 * when `statuses[cwd]` is undefined (would cause an infinite re-render loop). */
const EMPTY_STATUSES: GitStatusDetail[] = []

/** Join a cwd (absolute) with a relative git path, normalizing separators. */
function joinPath(cwd: string, relativePath: string): string {
  const normalizedCwd = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedRel = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  return `${normalizedCwd}/${normalizedRel}`
}

/** Extract the file name from a path that may use forward or backslash separators. */
function basename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.split('/').pop() || filePath
}

/** Extract the directory portion from a path that may use forward or backslash separators. */
function dirname(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? '' : normalized.substring(0, idx)
}

function FileRow({
  file,
  cwd,
  onOpen
}: {
  file: GitStatusDetail
  cwd: string
  onOpen: (path: string) => void
}) {
  const fileName = basename(file.path)
  const dirName = dirname(file.path)
  const fullPath = joinPath(cwd, file.path)

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpen(fullPath)
    }
  }

  return (
    <button
      type="button"
      onClick={() => onOpen(fullPath)}
      onKeyDown={handleKeyDown}
      className={cn(
        'group/row flex w-full items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer',
        'hover:bg-secondary/80 text-muted-foreground hover:text-foreground transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60'
      )}
    >
      <GitStatusBadge status={file.status} />
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <span className="text-2xs font-medium truncate leading-tight">{fileName}</span>
        {dirName && <span className="text-4xs truncate opacity-50 leading-tight">{dirName}</span>}
      </div>
    </button>
  )
}

interface ChatChangedFilesPanelProps {
  cwd: string
  activeTurn: boolean
}

/**
 * Collapsible, scrollable "Changed files" panel anchored on top of the
 * ChatInputBar while an agent turn is in flight. Reads from the global
 * `useGitStatusStore` (keyed by `cwd`) — no per-session store slice. Clicking a
 * file row opens it in the editor workspace. View-and-open-only: no staging,
 * diff, or commit actions.
 */
export function ChatChangedFilesPanel({
  cwd,
  activeTurn
}: ChatChangedFilesPanelProps): React.JSX.Element {
  const statuses = useGitStatusStore((s) => s.statuses[cwd] ?? EMPTY_STATUSES)
  const refreshStatus = useGitStatusStore((s) => s.refreshStatus)
  const [expanded, setExpanded] = useState(false)
  const timeoutRef = useRef<number | null>(null)

  // Fetch once on mount / when the turn starts. The count badge needs current
  // data even while collapsed.
  useEffect(() => {
    if (!activeTurn) return
    void refreshStatus(cwd).catch((err) => {
      void logFrontendError({
        level: 'warn',
        message: `ChatChangedFilesPanel: refreshStatus failed for ${cwd}: ${String(err)}`,
        source: 'ChatChangedFilesPanel'
      })
    })
  }, [activeTurn, cwd, refreshStatus])

  // Poll while expanded and turn is active. Uses recursive setTimeout instead
  // of setInterval so a slow refreshStatus cannot pile up overlapping calls.
  useEffect(() => {
    if (!activeTurn || !expanded) return

    const tick = (): void => {
      void refreshStatus(cwd).catch((err) => {
        void logFrontendError({
          level: 'warn',
          message: `ChatChangedFilesPanel: poll refreshStatus failed for ${cwd}: ${String(err)}`,
          source: 'ChatChangedFilesPanel'
        })
      })
      timeoutRef.current = setTimeout(tick, REFRESH_INTERVAL_MS)
    }
    timeoutRef.current = setTimeout(tick, REFRESH_INTERVAL_MS)

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
    }
  }, [activeTurn, expanded, cwd, refreshStatus])

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

  const count = statuses.length

  return (
    <div className={cn(CHAT_GUTTER_X, 'pb-1 pt-1')}>
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex w-full items-center gap-2 rounded-lg border border-border/60 bg-card/60',
              'px-3 py-1.5 text-xs text-muted-foreground transition-colors',
              'hover:bg-secondary/40 hover:text-foreground'
            )}
            aria-label={expanded ? 'Collapse changed files' : 'Expand changed files'}
          >
            <ChevronDown
              size={14}
              className={cn('shrink-0 transition-transform', expanded ? 'rotate-180' : 'rotate-0')}
            />
            <GitBranch size={13} className="shrink-0 text-muted-foreground/70" />
            <span className="font-medium">Changed files</span>
            <span className="ml-1 rounded-full bg-secondary px-1.5 py-0.5 text-3xs font-semibold">
              {count}
            </span>
            {count === 0 && <span className="ml-auto text-3xs opacity-50">No changes</span>}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ScrollArea className="max-h-48 w-full">
            <div className="space-y-0.5 p-1">
              {statuses.length === 0 ? (
                <div className="px-3 py-4 text-center">
                  <p className="text-xs text-muted-foreground">No changes detected</p>
                </div>
              ) : (
                statuses.map((file) => (
                  <FileRow
                    key={`${file.path}:${file.staged}`}
                    file={file}
                    cwd={cwd}
                    onOpen={handleOpenFile}
                  />
                ))
              )}
            </div>
          </ScrollArea>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
