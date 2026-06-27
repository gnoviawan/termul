import type { SearchFileHit } from '@shared/types/ipc.types'
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

const DEBOUNCE_MS = 120

export interface UseComposerMentionsOptions {
  /** Search root — `session.cwd` (the worktree when one is open). */
  rootPath: string | null | undefined
  /** Trusted boundary for the backend path validation — `projectRoot ?? session.cwd`. */
  scopeRoot: string | null | undefined
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
  /** Close the menu + drop in-flight matches (e.g. on send / blur). */
  reset: () => void
}

/** Build a {@link MentionMatch} from a backend hit + the search root. */
export function toMentionMatch(hit: SearchFileHit, rootPath: string): MentionMatch {
  const relPath = hit.path.replace(/\\/g, '/')
  const root = rootPath.replace(/\\/g, '/').replace(/\/$/, '')
  return {
    relPath,
    absPath: `${root}/${relPath}`,
    name: basename(relPath),
    ignored: hit.ignored
  }
}

export function useComposerMentions(opts: UseComposerMentionsOptions): ComposerMentions {
  const { rootPath, scopeRoot, disabled, recents, onStageFileRef } = opts
  const [menuOpen, setMenuOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [matches, setMatches] = useState<MentionMatch[]>([])
  const [loading, setLoading] = useState(false)
  const menuRef = useRef<FileMentionMenuHandle>(null)

  const requestIdRef = useRef(0)
  const activeSearchIdRef = useRef<string | null>(null)
  const rootPathRef = useRef(rootPath)
  rootPathRef.current = rootPath
  const onStageRef = useRef(onStageFileRef)
  onStageRef.current = onStageFileRef

  const cancelActive = useCallback(() => {
    const sid = activeSearchIdRef.current
    if (sid) {
      activeSearchIdRef.current = null
      void filesystemApi.searchFileNamesStreamCancel(sid).catch(() => {})
    }
  }, [])

  // Subscribe once to the filename-search stream events.
  useEffect(() => {
    const unbatch = filesystemApi.onSearchFileNamesBatch((event) => {
      if (event.searchId !== activeSearchIdRef.current) return
      const root = rootPathRef.current
      if (!root) return
      setMatches(event.files.map((f) => toMentionMatch(f, root)))
    })
    const unDone = filesystemApi.onSearchFileNamesDone((event) => {
      if (event.searchId !== activeSearchIdRef.current) return
      setLoading(false)
    })
    return () => {
      unbatch()
      unDone()
    }
  }, [])

  // Cancel any in-flight stream on unmount.
  useEffect(() => cancelActive, [cancelActive])

  // Drive the stream from the active filter.
  useEffect(() => {
    if (!menuOpen || disabled || !rootPath) {
      cancelActive()
      setMatches([])
      setLoading(false)
      return
    }
    const f = filter.trim()
    if (f === '') {
      cancelActive()
      setMatches([])
      setLoading(false)
      return
    }
    const scope = scopeRoot ?? rootPath
    const timer = setTimeout(() => {
      requestIdRef.current += 1
      const searchId = `mention-${requestIdRef.current}`
      activeSearchIdRef.current = searchId
      setLoading(true)
      setMatches([])
      void filesystemApi
        .searchFileNamesStreamStart(searchId, scope, rootPath, f, true)
        .catch(() => {
          if (activeSearchIdRef.current === searchId) {
            activeSearchIdRef.current = null
            setLoading(false)
          }
        })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [menuOpen, filter, rootPath, scopeRoot, disabled, cancelActive])

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
      cancelActive()
      onStageRef.current(match)
      return { value: nextValue, caret: token.at }
    },
    [cancelActive]
  )

  const reset = useCallback(() => {
    setMenuOpen(false)
    setFilter('')
    setMatches([])
    cancelActive()
  }, [cancelActive])

  const sections = buildMentionSections({ matches, recents, filter })

  return { menuOpen, filter, sections, loading, menuRef, update, select, reset }
}
