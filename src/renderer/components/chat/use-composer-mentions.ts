import type { DirectoryEntry } from '@shared/types/filesystem.types'
import type { SearchFileHit } from '@shared/types/ipc.types'
import type { RefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { filesystemApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { basename } from '@/lib/path-basename'
import { insertConversationToken, insertFileToken } from '@/lib/skill-tokens'
import { randomUUID } from '@/lib/uuid'
import {
  type FileMentionMenuHandle,
  MENTION_EMPTY_LABEL,
  MENTION_SEARCHING_LABEL
} from './FileMentionMenu'
import {
  activeMentionToken,
  buildMentionSections,
  CONVERSATIONS_EMPTY_LABEL,
  CONVERSATIONS_NO_MATCH_LABEL,
  type DirListing,
  folderDir,
  isFolderMatch,
  MAX_FOLDER_RESULTS,
  type MentionMatch,
  type MentionMenuView,
  type MentionPanel,
  type MentionRow,
  type MentionSection,
  type MentionToken,
  mentionPanelHeader,
  relativeDir
} from './mention-menu-model'
import { useMentionConversations } from './use-mention-conversations'

const MAX_RESULTS = 100

/**
 * Debounce window in ms before firing a filename-search stream. Matches the
 * file-explorer recipe: shorter queries (1-2 chars) get the longer window so
 * rapid typing does not spawn a stream per keystroke; >=3 chars feel instant.
 */
const DEBOUNCE_SHORT = 90
const DEBOUNCE_LONG = 180
/** Queries of at least this many chars use the short debounce window. */
const SHORT_QUERY_MIN = 3

/** Normalize a search root to forward slashes without a trailing separator. */
function normalizeRoot(root: string | null | undefined): string {
  return root?.replace(/\\/g, '/').replace(/\/$/, '') ?? ''
}

/**
 * Cancel an in-flight filename search stream and surface failures. The facade
 * resolves `{ success: false }` on cancel failure (and may reject on a
 * transport fault); both are logged so the boundary is never silently swallowed
 * (AGENTS.md logging rule).
 */
function cancelSearchStream(sid: string): void {
  void filesystemApi
    .searchFileNamesStreamCancel(sid)
    .then((res) => {
      if (res.success) return
      logFrontendError({
        level: 'warn',
        message: `composer mention search cancel failed: code=${res.code ?? 'n/a'} error=${res.error ?? 'n/a'}`,
        source: 'useComposerMentions'
      })
    })
    .catch((err) => {
      logFrontendError({
        level: 'warn',
        message: `composer mention search cancel rejected: ${err instanceof Error ? err.message : String(err)}`,
        source: 'useComposerMentions'
      })
    })
}

/** Build a {@link MentionMatch} from a ripgrep `SearchFileHit` + search root. */
function toMentionMatch(hit: SearchFileHit, root: string): MentionMatch {
  if (hit.kind === 'dir') {
    // Folder hits are root-relative with no trailing slash; the trailing `/` on
    // `absPath` is the dir marker the folder token carries (`isFolderTokenPath`).
    return {
      relPath: hit.path,
      absPath: `${root}/${hit.path}/`,
      name: basename(hit.path),
      ignored: hit.ignored,
      kind: 'dir'
    }
  }
  return {
    relPath: hit.path,
    absPath: `${root}/${hit.path}`,
    name: basename(hit.path),
    ignored: hit.ignored
  }
}

/**
 * Build a {@link MentionMatch} from a listing entry. Paths come from the
 * requested `dir`, never `entry.path`: the web server canonicalizes symlinks
 * and Windows may return `\\?\` paths, either of which would break the token.
 */
function toListingMatch(entry: DirectoryEntry, dir: string, root: string): MentionMatch {
  const relPath = `${relativeDir(root, dir)}${entry.name}`
  const ignored = entry.ignored ?? false
  if (entry.type === 'directory') {
    return { relPath, absPath: `${dir}/${entry.name}/`, name: entry.name, ignored, kind: 'dir' }
  }
  return { relPath, absPath: `${dir}/${entry.name}`, name: entry.name, ignored }
}

function logListingFailure(dir: string, detail: string): void {
  logFrontendError({
    level: 'warn',
    message: `composer mention folder listing failed: dir=${dir} ${detail}`,
    source: 'useComposerMentions'
  })
}

interface PanelStack {
  stack: MentionPanel[]
  enter: MentionMenuView['enter']
}

const ROOT_STACK: PanelStack = { stack: [{ kind: 'root' }], enter: 'none' }

function panelKey(depth: number, panel: MentionPanel): string {
  return panel.kind === 'explorer' ? `${depth}:explorer:${panel.dir}` : `${depth}:${panel.kind}`
}

function mentionEmptyLabel(panel: MentionPanel, filter: string, loading: boolean): string {
  if (panel.kind === 'conversations') {
    return filter.trim() === '' ? CONVERSATIONS_EMPTY_LABEL : CONVERSATIONS_NO_MATCH_LABEL
  }
  return loading ? MENTION_SEARCHING_LABEL : MENTION_EMPTY_LABEL
}

function clearQuery(value: string, token: MentionToken): { value: string; caret: number } {
  return { value: value.slice(0, token.at + 1) + value.slice(token.end), caret: token.at + 1 }
}

/**
 * Cap files at {@link MAX_RESULTS} and folders at {@link MAX_FOLDER_RESULTS}
 * independently, so a full page of file hits can never crowd folders out.
 */
function capMatches(matches: MentionMatch[]): MentionMatch[] {
  // The desktop stream emits cumulative snapshots (files, then folders in the
  // final batch), so dedupe by `absPath` before capping or repeats eat the caps.
  const seen = new Set<string>()
  const unique = matches.filter((m) => {
    if (seen.has(m.absPath)) return false
    seen.add(m.absPath)
    return true
  })
  const files = unique.filter((m) => !isFolderMatch(m)).slice(0, MAX_RESULTS)
  const folders = unique.filter(isFolderMatch).slice(0, MAX_FOLDER_RESULTS)
  return files.concat(folders)
}

export interface UseComposerMentionsOptions {
  /** Search root — `session.cwd` (the worktree when one is open). */
  rootPath: string | null | undefined
  disabled: boolean
  recents: MentionMatch[]
  /** Stage a `file-ref` attachment for the picked match. */
  onStageFileRef: (match: MentionMatch) => void
  projectId: string | null | undefined
  currentSessionId?: string | null
}

export interface ComposerMentions {
  menuOpen: boolean
  /** The active @token query (empty for a bare `@`). */
  filter: string
  sections: MentionSection[]
  view: MentionMenuView
  canGoBack: boolean
  back: () => void
  /** True while a filename-search stream is in flight for the current query. */
  loading: boolean
  menuRef: RefObject<FileMentionMenuHandle>
  /** Call on textarea input + selection change. */
  update: (value: string, caret: number) => void
  select: (value: string, caret: number, row: MentionRow) => { value: string; caret: number } | null
  /** Close the menu + drop matches (e.g. on send / blur). */
  reset: () => void
}

export function useComposerMentions(opts: UseComposerMentionsOptions): ComposerMentions {
  const { rootPath, disabled, recents, onStageFileRef, projectId, currentSessionId } = opts
  const [menuOpen, setMenuOpen] = useState(false)
  const conversations = useMentionConversations(menuOpen && !disabled, projectId, currentSessionId)
  const [filter, setFilter] = useState('')
  const [matches, setMatches] = useState<MentionMatch[]>([])
  const [loading, setLoading] = useState(false)
  const menuRef = useRef<FileMentionMenuHandle>(null)
  const [panels, setPanels] = useState<PanelStack>(ROOT_STACK)
  const tokenAtRef = useRef<number | null>(null)
  const listingsRef = useRef<Record<string, DirListing>>({})
  const [listings, setListings] = useState(listingsRef.current)
  const listingGenRef = useRef(0)
  const root = normalizeRoot(rootPath)
  const depth = panels.stack.length
  const panel = panels.stack[depth - 1] ?? ROOT_STACK.stack[0]
  const searchesFiles = panel.kind !== 'conversations'
  const onStageRef = useRef(onStageFileRef)
  onStageRef.current = onStageFileRef

  const reqIdRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Per-hook-instance prefix so search ids never collide with another
  // `useComposerMentions` instance or the file-explorer store's `search-N`
  // namespace — broadcast batch/done events only reach this listener.
  // Lazy-init so `randomUUID()` runs once per instance, not every render.
  const instanceIdRef = useRef<string>('')
  if (instanceIdRef.current === '') instanceIdRef.current = randomUUID()
  // The search id (`search-${reqId}`) whose batch/done events are currently
  // accepted. Stale events from a cancelled stream mismatch and are ignored.
  const activeSearchIdRef = useRef<string | null>(null)
  // Accumulator for the in-flight search's batches, capped at MAX_RESULTS.
  const accumRef = useRef<MentionMatch[]>([])
  // The mount-scoped batch listener can't close over `rootPath` (its effect has
  // no deps), so it reads the current root through this ref. Updated in an
  // effect, not during render, so the write can't leak from an uncommitted render.
  const rootPathRef = useRef(rootPath)
  useEffect(() => {
    rootPathRef.current = rootPath
  }, [rootPath])

  // Subscribe to the filename-stream events once per mount. Both transports
  // emit through this channel: desktop via Tauri events, web via the
  // facade's in-module emitter fed by the one-shot `GET /search/file-names`
  // request (issue #848) — so the id-gated batch/done handling below is
  // shared and the `isTauriContext` gate is gone.
  useEffect(() => {
    const unsubBatch = filesystemApi.onSearchFileNamesBatch((event) => {
      if (event.searchId !== activeSearchIdRef.current) return
      const root = normalizeRoot(rootPathRef.current)
      const next = capMatches(
        accumRef.current.concat(event.files.map((f) => toMentionMatch(f, root)))
      )
      accumRef.current = next
      setMatches(next)
    })
    const unsubDone = filesystemApi.onSearchFileNamesDone((event) => {
      if (event.searchId !== activeSearchIdRef.current) return
      activeSearchIdRef.current = null
      setLoading(false)
      if (event.code || event.error) {
        logFrontendError({
          level: 'warn',
          message:
            `composer mention search done with error: code=${event.code ?? 'n/a'}` +
            ` error=${event.error ?? 'n/a'}`,
          source: 'useComposerMentions'
        })
        setMatches([])
      }
    })
    return () => {
      unsubBatch()
      unsubDone()
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      const sid = activeSearchIdRef.current
      if (sid) {
        activeSearchIdRef.current = null
        cancelSearchStream(sid)
      }
      setLoading(false)
    }
  }, [])

  // Debounced per-keystroke stream: cancel any in-flight stream, bump the
  // request id, and schedule a new start. Batches whose searchId != active
  // are dropped by the listeners above. Mirrors `file-explorer-store.ts`.
  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    // Cancel any in-flight stream before considering a new one.
    const prevSid = activeSearchIdRef.current
    if (prevSid) {
      activeSearchIdRef.current = null
      cancelSearchStream(prevSid)
    }

    if (!menuOpen || disabled || !rootPath || !searchesFiles) {
      accumRef.current = []
      setMatches([])
      setLoading(false)
      return
    }
    const f = filter.trim()
    if (f === '') {
      // Bare `@`: no search, Recents render.
      accumRef.current = []
      setMatches([])
      setLoading(false)
      return
    }

    const id = ++reqIdRef.current
    const sid = `search-${instanceIdRef.current}-${id}`
    accumRef.current = []
    // Drop stale matches from the previous query so they don't flash during
    // the debounce window before the first batch lands.
    setMatches([])
    timerRef.current = setTimeout(
      () => {
        timerRef.current = null
        activeSearchIdRef.current = sid
        const root = normalizeRoot(rootPath)
        setLoading(true)
        void filesystemApi
          .searchFileNamesStreamStart(sid, root, root, f, false)
          .then((res) => {
            if (res.success) return
            // Failed start: no stream will emit done — drop loading now and
            // surface the failure so it is never silently swallowed.
            if (activeSearchIdRef.current === sid) {
              activeSearchIdRef.current = null
              setLoading(false)
              setMatches([])
            }
            logFrontendError({
              level: 'warn',
              message:
                `composer mention search start failed: code=${res.code ?? 'n/a'}` +
                ` error=${res.error ?? 'n/a'}`,
              source: 'useComposerMentions'
            })
          })
          .catch((err) => {
            // Defense-in-depth: the facade resolves even on invoke failure, but
            // a transport fault rejecting the promise must not pin `loading`.
            if (activeSearchIdRef.current === sid) {
              activeSearchIdRef.current = null
              setLoading(false)
              setMatches([])
            }
            logFrontendError({
              level: 'warn',
              message: `composer mention search start rejected: ${err instanceof Error ? err.message : String(err)}`,
              source: 'useComposerMentions'
            })
          })
      },
      f.length >= SHORT_QUERY_MIN ? DEBOUNCE_SHORT : DEBOUNCE_LONG
    )
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [menuOpen, filter, rootPath, disabled, searchesFiles])

  const explorerDir = menuOpen && !disabled && panel.kind === 'explorer' ? panel.dir : null

  useEffect(() => {
    if (explorerDir === null || listingsRef.current[explorerDir]) return
    const dir = explorerDir
    const gen = listingGenRef.current
    const store = (listing: DirListing) => {
      if (gen !== listingGenRef.current) return
      listingsRef.current = { ...listingsRef.current, [dir]: listing }
      setListings(listingsRef.current)
    }
    store({ status: 'loading' })
    void filesystemApi
      .readDirectory(dir)
      .then((res) => {
        if (res.success) {
          store({ status: 'ready', entries: res.data.map((e) => toListingMatch(e, dir, root)) })
          return
        }
        logListingFailure(dir, `code=${res.code ?? 'n/a'} error=${res.error ?? 'n/a'}`)
        store({ status: 'error' })
      })
      .catch((err) => {
        logListingFailure(dir, `rejected: ${err instanceof Error ? err.message : String(err)}`)
        store({ status: 'error' })
      })
  }, [explorerDir, root])

  const close = useCallback(() => {
    setMenuOpen(false)
    setFilter('')
    setMatches([])
    setPanels(ROOT_STACK)
    tokenAtRef.current = null
    listingGenRef.current += 1
    listingsRef.current = {}
    setListings(listingsRef.current)
  }, [])

  const update = useCallback(
    (value: string, caret: number) => {
      const token = activeMentionToken(value, caret)
      if (token === null) {
        if (tokenAtRef.current !== null) close()
        return
      }
      if (token.at !== tokenAtRef.current) setPanels(ROOT_STACK)
      tokenAtRef.current = token.at
      setMenuOpen(true)
      setFilter(token.query)
    },
    [close]
  )

  const push = useCallback((next: MentionPanel) => {
    setPanels((p) => ({ stack: [...p.stack, next], enter: 'forward' }))
  }, [])

  const back = useCallback(() => {
    setPanels((p) => (p.stack.length > 1 ? { stack: p.stack.slice(0, -1), enter: 'back' } : p))
  }, [])

  const select = useCallback(
    (value: string, caret: number, row: MentionRow): { value: string; caret: number } | null => {
      const token = activeMentionToken(value, caret)
      if (!token) return null
      if (row.kind === 'category') {
        push(
          row.target === 'explorer' ? { kind: 'explorer', dir: root } : { kind: 'conversations' }
        )
        return clearQuery(value, token)
      }
      if (row.kind === 'conversation') {
        close()
        return insertConversationToken(
          value,
          token.end,
          row.conversation.title,
          row.conversation.sessionId,
          token.end - token.at
        )
      }
      if (row.kind === 'dir') {
        push({ kind: 'explorer', dir: folderDir(row.match) })
        return clearQuery(value, token)
      }
      const { match } = row
      // A folder pick reuses the file token: display is the relative path with a
      // trailing `/`, `absPath` keeps its trailing `/` as the dir marker, and the
      // wire builder turns it into plain text (no resource_link).
      // Splice a file token IN at the caret (instead of hoisting to the
      // attachment bar). Removes the `@filter` text, inserts the token, and
      // appends a trailing space so the caret lands in plain text. The token
      // IS the staging — the wire builder extracts file paths from tokens at
      // send time. `onStageRef` still fires so the host wrapper can record the
      // mention in recents (the host wrapper no longer calls `addFileRef`).
      const { value: nextValue, caret: nextCaret } = insertFileToken(
        value,
        token.end,
        isFolderMatch(match) ? `${match.relPath}/` : match.name,
        match.absPath,
        token.end - token.at
      )
      close()
      onStageRef.current(match)
      return { value: nextValue, caret: nextCaret }
    },
    [close, push, root]
  )

  const sections = buildMentionSections({
    panel,
    root,
    filter,
    matches,
    recents,
    conversations,
    listing: panel.kind === 'explorer' ? listings[panel.dir] : undefined
  })
  const view: MentionMenuView = {
    panelKey: panelKey(depth, panel),
    header: mentionPanelHeader(panel, root),
    enter: panels.enter,
    sections,
    emptyLabel: mentionEmptyLabel(panel, filter, loading)
  }

  return {
    menuOpen,
    filter,
    sections,
    view,
    canGoBack: depth > 1,
    back,
    loading,
    menuRef,
    update,
    select,
    reset: close
  }
}
