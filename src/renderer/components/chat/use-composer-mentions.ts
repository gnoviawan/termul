import type { FileChangeEvent } from '@shared/types/ipc.types'
import { readDir } from '@tauri-apps/plugin-fs'
import type { RefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { filesystemApi } from '@/lib/api'
import { basename } from './chat-attachments'
import type { FileMentionMenuHandle } from './FileMentionMenu'
import {
  activeMentionToken,
  buildMentionSections,
  type MentionMatch,
  type MentionSection,
  spliceMentionToken
} from './mention-menu-model'

const MAX_RESULTS = 100
/** Max projects kept in the module-level file cache (LRU-bounded). */
const CACHE_MAX = 8

/**
 * Directory basenames (and a few cruft files) skipped during the project file
 * walk. Mirrors the backend `COMMONLY_IGNORED_NAMES` so the mention picker
 * only surfaces source files — matching the file-explorer search — instead of
 * `node_modules` / `.git` / build artifacts. See ADR 0003.
 */
const SKIP_NAMES = new Set([
  'node_modules',
  '.git',
  '.next',
  '.cache',
  '.turbo',
  'dist',
  'build',
  '.output',
  '.nuxt',
  '.svelte-kit',
  '__pycache__',
  '.pytest_cache',
  'venv',
  'coverage',
  '.nyc_output',
  '.env',
  'Thumbs.db',
  'desktop.ini',
  '.DS_Store'
])

/**
 * Module-level cache: `rootPath` -> forward-slash-relative file paths. Walked
 * lazily once per project on the first @-mention, then filtered in-memory per
 * keystroke. Invalidated on file-change events (piggybacking whatever watcher
 * the file-explorer has active) so newly added files appear on the next open.
 */
const fileCache = new Map<string, string[]>()

/** @internal Reset the project-file cache between tests. */
export function __resetMentionFileCache(): void {
  fileCache.clear()
}

/** Recursively walk `rootPath` via `readDir`, returning forward-slash-relative paths. */
async function collectProjectFiles(rootPath: string): Promise<string[]> {
  const root = rootPath.replace(/\\/g, '/').replace(/\/$/, '')
  const files: string[] = []
  const queue: string[] = [root]
  while (queue.length > 0) {
    const dir = queue.shift()
    if (!dir) continue
    let entries: Awaited<ReturnType<typeof readDir>>
    try {
      entries = await readDir(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name)) continue
      const full = `${dir}/${entry.name}`.replace(/\/+/g, '/')
      if (entry.isDirectory) queue.push(full)
      else files.push(full.slice(root.length + 1))
    }
  }
  return files
}

/** Build a {@link MentionMatch} from a relative path + the search root. */
function toMentionMatch(relPath: string, rootPath: string): MentionMatch {
  return {
    relPath,
    absPath: `${rootPath}/${relPath}`,
    name: basename(relPath),
    ignored: false
  }
}

export interface UseComposerMentionsOptions {
  /** Search root — `session.cwd` (the worktree when one is open). */
  rootPath: string | null | undefined
  disabled: boolean
  recents: MentionMatch[]
  /** Stage a `file-ref` attachment for the picked match. */
  onStageFileRef: (match: MentionMatch) => void
}

export interface ComposerMentions {
  menuOpen: boolean
  /** The active @token query (empty for a bare `@`). */
  filter: string
  sections: MentionSection[]
  /** True while the project file list is being walked (first open / re-walk). */
  loading: boolean
  menuRef: RefObject<FileMentionMenuHandle>
  /** Call on textarea input + selection change. */
  update: (value: string, caret: number) => void
  /** Select a match: returns new { value, caret } to apply; stages the file-ref. */
  select: (
    value: string,
    caret: number,
    match: MentionMatch
  ) => { value: string; caret: number } | null
  /** Close the menu + drop matches (e.g. on send / blur). */
  reset: () => void
}

export function useComposerMentions(opts: UseComposerMentionsOptions): ComposerMentions {
  const { rootPath, disabled, recents, onStageFileRef } = opts
  const [menuOpen, setMenuOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [matches, setMatches] = useState<MentionMatch[]>([])
  const [loading, setLoading] = useState(false)
  const [cacheReady, setCacheReady] = useState(false)
  const menuRef = useRef<FileMentionMenuHandle>(null)
  const onStageRef = useRef(onStageFileRef)
  onStageRef.current = onStageFileRef
  // True when a file-change landed during an in-flight walk — the walk must
  // discard its stale result and re-walk before caching.
  const dirtyRef = useRef(false)

  // Invalidate the cache when files under `rootPath` change so the next menu
  // open re-walks. Events fire globally for every watched dir, so filter by
  // path prefix to avoid dropping the cache on unrelated projects' changes.
  useEffect(() => {
    if (!rootPath) return
    const root = rootPath.replace(/\\/g, '/')
    const invalidate = (event: FileChangeEvent) => {
      if (!event.path.replace(/\\/g, '/').startsWith(root)) return
      if (fileCache.delete(rootPath)) {
        setCacheReady((r) => (r ? false : r))
      } else {
        // Cache not populated yet — flag the in-flight walk as stale so it
        // re-walks before caching its (now-out-of-date) result.
        dirtyRef.current = true
      }
    }
    const u1 = filesystemApi.onFileChanged(invalidate)
    const u2 = filesystemApi.onFileCreated(invalidate)
    const u3 = filesystemApi.onFileDeleted(invalidate)
    return () => {
      u1()
      u2()
      u3()
    }
  }, [rootPath])

  // Walk the project tree lazily when the menu opens and the cache is empty.
  // Re-walks after an invalidation (cacheReady flips back to false) while the
  // menu is still open. Does NOT depend on `filter`, so typing does not cancel
  // an in-flight walk. The module cache is LRU-bounded (CACHE_MAX) so opening
  // many distinct projects does not grow memory unbounded.
  useEffect(() => {
    if (!menuOpen || !rootPath || disabled) return
    if (fileCache.has(rootPath)) {
      // Refresh LRU recency on hit (Map.set on an existing key keeps order).
      const cached = fileCache.get(rootPath)
      if (cached) {
        fileCache.delete(rootPath)
        fileCache.set(rootPath, cached)
      }
      if (!cacheReady) setCacheReady(true)
      return
    }
    let cancelled = false
    setLoading(true)
    const finish = (files: string[]) => {
      if (cancelled) return
      if (dirtyRef.current) {
        // A change landed while this walk was in flight — discard the stale
        // result and re-walk before caching.
        dirtyRef.current = false
        void collectProjectFiles(rootPath).then(finish)
        return
      }
      fileCache.set(rootPath, files)
      if (fileCache.size > CACHE_MAX) {
        const oldest = fileCache.keys().next().value
        if (oldest !== undefined && oldest !== rootPath) fileCache.delete(oldest)
      }
      setLoading(false)
      setCacheReady(true)
    }
    void collectProjectFiles(rootPath).then(finish)
    return () => {
      cancelled = true
    }
  }, [menuOpen, rootPath, disabled, cacheReady])

  // Filter the cached file list in-memory per keystroke. The basename-contains
  // match mirrors the old `rg --iglob **/*query*` behavior without the round-trip.
  useEffect(() => {
    if (!menuOpen || disabled || !rootPath || !cacheReady) {
      setMatches([])
      return
    }
    const f = filter.trim()
    if (f === '') {
      setMatches([])
      return
    }
    const root = rootPath.replace(/\\/g, '/').replace(/\/$/, '')
    const cached = fileCache.get(rootPath) ?? []
    const lower = f.toLowerCase()
    setMatches(
      cached
        .filter((p) => basename(p).toLowerCase().includes(lower))
        .slice(0, MAX_RESULTS)
        .map((p) => toMentionMatch(p, root))
    )
  }, [menuOpen, filter, rootPath, disabled, cacheReady])

  const update = useCallback((value: string, caret: number) => {
    const token = activeMentionToken(value, caret)
    setMenuOpen(token !== null)
    setFilter(token?.query ?? '')
    if (token === null) setMatches([])
  }, [])

  const select = useCallback(
    (
      value: string,
      caret: number,
      match: MentionMatch
    ): { value: string; caret: number } | null => {
      const token = activeMentionToken(value, caret)
      if (!token) return null
      const nextValue = spliceMentionToken(value, token)
      setMenuOpen(false)
      setFilter('')
      setMatches([])
      onStageRef.current(match)
      return { value: nextValue, caret: token.at }
    },
    []
  )

  const reset = useCallback(() => {
    setMenuOpen(false)
    setFilter('')
    setMatches([])
  }, [])

  const sections = buildMentionSections({ matches, recents, filter })

  return { menuOpen, filter, sections, loading, menuRef, update, select, reset }
}
