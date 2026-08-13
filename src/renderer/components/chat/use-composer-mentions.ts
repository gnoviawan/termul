import type { SearchFileHit } from '@shared/types/ipc.types'
import type { RefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { filesystemApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { isTauriContext } from '@/lib/tauri-runtime'
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

/**
 * Debounce window in ms before firing a filename-search stream. Matches the
 * file-explorer recipe: shorter queries (1-2 chars) get the longer window so
 * rapid typing does not spawn a stream per keystroke; >=3 chars feel instant.
 */
const DEBOUNCE_SHORT = 90
const DEBOUNCE_LONG = 180
/** Queries of at least this many chars use the short debounce window. */
const SHORT_QUERY_MIN = 3

/** Build a {@link MentionMatch} from a ripgrep `SearchFileHit` + search root. */
function toMentionMatch(hit: SearchFileHit, root: string): MentionMatch {
  return {
    relPath: hit.path,
    absPath: `${root}/${hit.path}`,
    name: basename(hit.path),
    ignored: hit.ignored
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
  /** True while a filename-search stream is in flight for the current query. */
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
  const menuRef = useRef<FileMentionMenuHandle>(null)
  const onStageRef = useRef(onStageFileRef)
  onStageRef.current = onStageFileRef

  const reqIdRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The search id (`search-${reqId}`) whose batch/done events are currently
  // accepted. Stale events from a cancelled stream mismatch and are ignored.
  const activeSearchIdRef = useRef<string | null>(null)
  // Accumulator for the in-flight search's batches, capped at MAX_RESULTS.
  const accumRef = useRef<MentionMatch[]>([])
  const rootPathRef = useRef(rootPath)
  rootPathRef.current = rootPath

  // Subscribe to the filename-stream events once per mount (desktop only).
  // Web (`!isTauriContext()`) never starts a stream and these return no-ops.
  useEffect(() => {
    if (!isTauriContext()) return
    const unsubBatch = filesystemApi.onSearchFileNamesBatch((event) => {
      if (event.searchId !== activeSearchIdRef.current) return
      const root = rootPathRef.current?.replace(/\\/g, '/').replace(/\/$/, '') ?? ''
      const next = accumRef.current
        .concat(event.files.map((f) => toMentionMatch(f, root)))
        .slice(0, MAX_RESULTS)
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
        filesystemApi.searchFileNamesStreamCancel(sid).catch(() => {})
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
      filesystemApi.searchFileNamesStreamCancel(prevSid).catch(() => {})
    }

    if (!menuOpen || disabled || !rootPath || !isTauriContext()) {
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
    const sid = `search-${id}`
    accumRef.current = []
    timerRef.current = setTimeout(
      () => {
        timerRef.current = null
        activeSearchIdRef.current = sid
        const root = rootPathRef.current?.replace(/\\/g, '/').replace(/\/$/, '') ?? ''
        setLoading(true)
        void filesystemApi.searchFileNamesStreamStart(sid, root, root, f, false).then((res) => {
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
      },
      f.length >= SHORT_QUERY_MIN ? DEBOUNCE_SHORT : DEBOUNCE_LONG
    )
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [menuOpen, filter, rootPath, disabled])

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
