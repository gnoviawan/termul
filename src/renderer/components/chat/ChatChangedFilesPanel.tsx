import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { CHAT_GUTTER_X, CHAT_HIT_MIN_H } from '@/components/chat/chat-layout'
import { baseName, describeToolCall, toolCallPath } from '@/components/chat/tool-call-summary'
import { MaterialFileIcon } from '@/components/file-explorer/MaterialFileIcon'
import { GitStatusLetter } from '@/components/git/rows'
import { ChevronDown, ChevronRight, FileDiff } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import { DiffStatCounts } from '@/components/ui/diff-stat-counts'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import type { ToolCall } from '@/lib/acp-api'
import { GIT_STATUS_LABEL, type GitDisplayStatus } from '@/lib/git-status-display'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'
import { useEditorStore } from '@/stores/editor-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useForcedCollapse } from './use-forced-collapse'
import { useGitChangedFiles } from './use-git-changed-files'

type ChangedFileKind = 'edit' | 'delete' | 'move'

const KIND_STATUS: Record<ChangedFileKind, GitDisplayStatus> = {
  edit: 'modified',
  delete: 'deleted',
  move: 'renamed'
}

function isChangedFileKind(kind: string | undefined): kind is ChangedFileKind {
  return kind === 'edit' || kind === 'delete' || kind === 'move'
}

/**
 * The kind a call settles the file into, or null when it settles nothing: a
 * failed call changed nothing, and a delete still awaiting approval or running
 * has not removed the file yet.
 */
function settledKind(kind: ChangedFileKind, status: ToolCall['status']): ChangedFileKind | null {
  if (status === 'failed') return null
  if (kind === 'delete' && status !== 'completed') return null
  return kind
}

/** A changed file: from git status, or (outside a git repository) from the
 * ACP tool calls of this session. */
interface ChangedFile {
  /** Resolved full path — forward slashes, cwd-joined. Also the dedupe key. */
  path: string
  status: GitDisplayStatus | null
  added: number
  removed: number
}

/**
 * POSIX-style normalization on a `/`-separated path: collapse `.` segments
 * and duplicate slashes, resolve `..` by popping the previous segment, strip
 * trailing separators. `..` that would climb past a `/` or `C:/` root is
 * dropped; leading `..` on a relative path is kept (it escapes the base).
 * The drive letter is canonicalized to uppercase (`c:` ≡ `C:` — the rest of
 * the path keeps its case since directories may be case-sensitive) and a
 * leading `//` UNC prefix is preserved. So `./x`, `a//x`, `a/b/../x`, and
 * `x/` all canonicalize alike.
 */
function canonicalizePath(path: string): string {
  const p = path.replace(/^([a-zA-Z]):/, (m) => m.toUpperCase())
  const isDriveRooted = /^[a-zA-Z]:\//.test(p)
  const isUnc = !isDriveRooted && p.startsWith('//')
  const isRooted = isDriveRooted || isUnc || p.startsWith('/')
  const minLen = isDriveRooted ? 1 : 0 // never pop the drive letter
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > minLen && out[out.length - 1] !== '..') {
        out.pop()
      } else if (!isRooted) {
        out.push('..')
      }
      continue
    }
    out.push(seg)
  }
  const body = out.join('/')
  return isRooted ? (isDriveRooted ? body : `${isUnc ? '//' : '/'}${body}`) : body
}

/**
 * `cwd` canonicalized for join/prefix math. An all-separator cwd ('/',
 * '///', '\\\\') survives as '/' so a relative path still joins absolute.
 */
function normalizeCwd(cwd: string): string {
  return canonicalizePath(cwd.replace(/\\/g, '/'))
}

/**
 * Canonical form shared by dedupe, the row tooltip, and the open action:
 * forward slashes, relative paths joined onto `cwd`, then `.`/`..`/duplicate
 * slashes collapsed so all spellings of one file share a key. With no cwd the
 * normalized path stands as given.
 */
function resolveFilePath(path: string, cwd: string): string {
  const normalized = path.replace(/\\/g, '/')
  const isAbsolute = /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('/')
  const base = normalizeCwd(cwd)
  const joined = isAbsolute || !base ? normalized : `${base}/${normalized}`
  return canonicalizePath(joined)
}

/**
 * Directory portion for the row subtitle: relative to `cwd` when the file sits
 * under it (so `src/components`, not `/work/src/components`), else the full
 * directory part. Empty for basename-only paths.
 */
function dirName(fullPath: string, cwd: string): string {
  const base = normalizeCwd(cwd)
  // Root cwd: the prefix is '/', not '//'.
  const prefix = base === '/' ? '/' : `${base}/`
  const display = base && fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath
  const idx = display.lastIndexOf('/')
  return idx >= 0 ? display.slice(0, idx) : ''
}

/** Extract file-changing tool calls (edit, delete, move) from the session's
 * tool-call list, deduplicated to one row per resolved path. Paths come from
 * `toolCallPath` (locations → rawInput → diff content) and are normalized via
 * `resolveFilePath`, so `src/foo.ts` and `/work/src/foo.ts` merge under cwd
 * `/work`. Add/remove counts — `describeToolCall().diffStat`, the same
 * battle-tested path used by ToolCallCard — are summed across all contributing
 * calls; `status` comes from the last call that took effect (see
 * `settledKind()`). First-appearance order kept. */
function extractChangedFiles(toolCalls: ToolCall[], cwd: string): ChangedFile[] {
  const files: ChangedFile[] = []
  const byPath = new Map<string, ChangedFile>()
  for (const tc of toolCalls) {
    const kind = tc.kind
    if (!isChangedFileKind(kind)) continue
    // `locations[].path` arrives untrimmed — a whitespace-only path would
    // otherwise key a garbage row like `<cwd>/   `.
    const rawPath = toolCallPath(tc)?.trim()
    if (!rawPath) continue
    const path = resolveFilePath(rawPath, cwd).trim()
    // A dot-only path ('.', 'a/..') can canonicalize to empty.
    if (!path) continue
    const stat = describeToolCall(tc).diffStat ?? { added: 0, removed: 0 }
    const settled = settledKind(kind, tc.status)
    const status = settled && KIND_STATUS[settled]
    const existing = byPath.get(path)
    if (existing) {
      existing.added += stat.added
      existing.removed += stat.removed
      existing.status = status ?? existing.status
      continue
    }
    const file: ChangedFile = {
      path,
      status,
      added: stat.added,
      removed: stat.removed
    }
    byPath.set(path, file)
    files.push(file)
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
  // `file.path` is already the resolved full path; `dir` shows it relative to
  // `cwd` when the file sits underneath (GitPanel FileItem row shape).
  const dir = dirName(file.path, cwd)
  // A separators-only path ('/') has no basename — show the path itself.
  const label = baseName(file.path) || file.path
  const hasCounts = file.added > 0 || file.removed > 0
  const status = file.status
  const isDeleted = status === 'deleted'

  const content = (
    <>
      <MaterialFileIcon name={label} isDirectory={false} isExpanded={false} depth={0} size={14} />
      <span className={cn('min-w-0 flex-1', isDeleted && 'line-through')}>
        <span className="block truncate text-2xs font-medium leading-tight">{label}</span>
        {dir && <span className="block truncate text-4xs leading-tight opacity-50">{dir}</span>}
      </span>
      {hasCounts && (
        <span className="shrink-0 font-mono text-2xs leading-tight">
          <DiffStatCounts added={file.added} removed={file.removed} />
        </span>
      )}
      {status && <GitStatusLetter status={status} />}
    </>
  )
  const rowClass = cn(
    'flex w-full items-center gap-2 rounded-md px-3 text-left text-muted-foreground select-none',
    CHAT_HIT_MIN_H
  )

  if (isDeleted) {
    const deletedLabel = `Deleted: ${file.path}`
    return (
      // biome-ignore lint/a11y/useSemanticElements: a fieldset would give a static row form semantics
      <div
        role="group"
        title={deletedLabel}
        aria-label={deletedLabel}
        className={cn(rowClass, 'cursor-default')}
      >
        {content}
      </div>
    )
  }

  return (
    <button
      type="button"
      data-press-feedback="off"
      title={file.path}
      // `title` is hover-only; the aria-label carries the resolved path and the
      // change kind to touch and screen-reader users.
      aria-label={status ? `${file.path}, ${GIT_STATUS_LABEL[status]}` : file.path}
      onClick={() => onOpen(file.path)}
      className={cn(
        rowClass,
        'group/row cursor-pointer transition-[background-color,color] duration-150 ease-out motion-reduce:transition-none',
        'hover:bg-secondary/60 hover:text-foreground',
        'active:bg-secondary/80',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'
      )}
    >
      {content}
    </button>
  )
}

interface ChatChangedFilesPanelProps {
  cwd: string
  toolCalls: ToolCall[]
  /** The agent turn is running; its end refreshes git state. */
  turnActive?: boolean
  /**
   * Mobile dock: adds a "Git" action beside the header that opens the Git
   * sheet. It is called with the tapped button, which the Git sheet returns
   * focus to when it closes. When omitted (desktop) the header renders exactly
   * as before.
   */
  onOpenGitChanges?: (opener: HTMLElement) => void
  /**
   * Render collapsed while true (keyboard up with an approval pending). A
   * header tap during the window still flips the rendered state; afterwards
   * the panel shows the user's last own state.
   */
  forceCollapsed?: boolean
}

/**
 * Collapsible, scrollable "Changed files" panel anchored on top of the
 * ChatInputBar. In a git repository it lists the uncommitted files of the
 * checkout at `cwd` (staged, unstaged and untracked, against HEAD) with their
 * git line counts, so a committed, discarded or deleted file drops out and a
 * clean tree hides the panel. Outside a git repository it lists the files
 * touched by ACP tool calls (edit/delete/move) in the current session — a
 * file edited by several calls appears once with summed +N −N counts.
 * Clicking a row opens the file in the editor workspace; a deleted file's
 * row opens nothing. View-and-open-only.
 *
 * The panel sits behind the chatbox (z-0 vs z-10). A negative bottom margin
 * extends the panel's translucent bg-card/60 behind the chatbox's rounded top
 * corners, covering the transparent gap. The visible content has bottom
 * padding so text clears the overlap zone.
 */
export function ChatChangedFilesPanel({
  cwd,
  toolCalls,
  turnActive = false,
  onOpenGitChanges,
  forceCollapsed = false
}: ChatChangedFilesPanelProps): React.JSX.Element | null {
  const isMobileShell = useMobileWebShell()
  const { collapsed, toggle } = useForcedCollapse(true, forceCollapsed)
  const expanded = !collapsed

  const git = useGitChangedFiles(cwd, toolCalls, turnActive)
  const files = useMemo((): ChangedFile[] => {
    if (git.state === 'unavailable') return extractChangedFiles(toolCalls, cwd)
    if (git.state === 'loading') return []
    return git.files.map((file) => ({ ...file, path: resolveFilePath(file.path, git.root) }))
  }, [git, toolCalls, cwd])
  // Row subtitles are relative to the base the paths were resolved against.
  const rowBase = git.state === 'ready' ? git.root : cwd
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

  const toggleButton = (
    <button
      type="button"
      data-press-feedback="off"
      onClick={toggle}
      className={cn(
        'flex w-full items-center gap-2 rounded-t-2xl px-3 text-left',
        CHAT_HIT_MIN_H,
        onOpenGitChanges && 'min-w-0 flex-1',
        // The composer covers the bottom 24px of the collapsed bar (-mb-6), so
        // the strip left to tap is `pt + line + pb - 24px`. With the Git action
        // that strip must reach 44px for its hit area (the card clips its
        // slop above): pt-4 + pb-9 leaves ~45px; without it, 32px as before.
        expanded ? 'py-2' : onOpenGitChanges ? 'pt-4 pb-9' : 'pt-2 pb-8',
        'cursor-pointer text-xs text-muted-foreground',
        'select-none appearance-none transition-[background-color,color] duration-150 ease-out',
        'hover:bg-secondary/60 hover:text-foreground',
        'active:bg-secondary/80',
        'focus-visible:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none'
      )}
      aria-expanded={expanded}
      // On mobile the visible text names the button ("Changed files 3 +17 −2").
      aria-label={
        isMobileShell ? undefined : expanded ? 'Collapse changed files' : 'Expand changed files'
      }
    >
      <ChevronDown
        size={14}
        className={cn(
          'shrink-0 transition-transform duration-[var(--acc-chevron)] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          expanded ? 'rotate-180' : 'rotate-0'
        )}
      />
      <FileDiff size={13} className="shrink-0 text-muted-foreground/70" />
      <span className="font-medium">Changed files</span>{' '}
      <span className="rounded-full bg-secondary px-1.5 py-0.5 text-3xs font-semibold tabular-nums">
        {count}
      </span>{' '}
      {hasTotalCounts && (
        <span className="ms-auto shrink-0 font-mono text-2xs tabular-nums">
          <DiffStatCounts added={totalAdded} removed={totalRemoved} />
        </span>
      )}
    </button>
  )

  return (
    <div className={cn(CHAT_GUTTER_X, '-mb-6 pt-0')}>
      <div className="relative mx-auto w-full max-w-3xl">
        <div className="relative z-0 overflow-hidden rounded-t-2xl border border-b-0 border-border/60 bg-card/60 select-none">
          {onOpenGitChanges ? (
            <div className="flex items-start">
              {toggleButton}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label="Open Git changes"
                onClick={(event) => onOpenGitChanges(event.currentTarget)}
                className="relative me-2 mt-2 shrink-0 text-muted-foreground after:absolute after:-inset-2 after:content-[''] [&_svg]:size-3"
              >
                Git
                <ChevronRight size={12} aria-hidden="true" />
              </Button>
            </div>
          ) : (
            toggleButton
          )}
          <CollapseExpandMotion open={expanded} motion="chat">
            <div className="pb-6">
              <div className="scroller-thin max-h-48 overflow-y-auto">
                <div className="space-y-0.5 p-1">
                  {files.map((file) => (
                    <FileRow key={file.path} file={file} cwd={rowBase} onOpen={handleOpenFile} />
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
