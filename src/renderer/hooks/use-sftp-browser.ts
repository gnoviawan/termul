import type { SFTPEntry } from '@shared/types/ssh.types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { sshApi } from '@/lib/api'

/** Parent of a remote POSIX path (`/` stays `/`). */
export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  return index <= 0 ? '/' : trimmed.slice(0, index)
}

/** `dir` + `name` without doubling the separator. */
export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`
}

/**
 * File browser state for one connected session. `connectionId` is the
 * session's backend id; SFTP runs as an extra channel on that connection.
 * A different id (another tab, a reconnect) starts over at the login
 * directory, and replies for a previous id are dropped.
 */
export function useSftpBrowser(connectionId: string | null) {
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [entries, setEntries] = useState<SFTPEntry[]>([])
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [childEntries, setChildEntries] = useState<Map<string, SFTPEntry[]>>(new Map())
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set())
  const [isLoadingRoot, setIsLoadingRoot] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A new token per connection change; replies for an older token are dropped
  // (even when switching back to the same id).
  const [session, setSession] = useState({ id: connectionId })
  const activeSession = useRef(session)
  activeSession.current = session
  // Bumped by each root listing, so only the latest one lands.
  const rootRequest = useRef(0)

  // A new connection starts fresh at the login directory. Reset while
  // rendering so no frame shows the previous session's files.
  if (session.id !== connectionId) {
    setSession({ id: connectionId })
    setCurrentPath(null)
    setEntries([])
    setExpandedDirs(new Set())
    setChildEntries(new Map())
    setLoadingDirs(new Set())
    setError(null)
    setIsLoadingRoot(false)
  }

  const loadDirectory = useCallback(
    async (path: string) => {
      if (!connectionId) return
      const request = ++rootRequest.current
      setIsLoadingRoot(true)
      setError(null)
      const result = await sshApi.sftpListDir(connectionId, path)
      if (session !== activeSession.current || request !== rootRequest.current) return
      setIsLoadingRoot(false)
      if (result.success) {
        setEntries(result.data)
        setCurrentPath(path)
        setExpandedDirs(new Set())
        setChildEntries(new Map())
      } else {
        setError(result.error)
      }
    },
    [connectionId, session]
  )

  const openHome = useCallback(async () => {
    if (!connectionId) return
    const request = ++rootRequest.current
    setIsLoadingRoot(true)
    setError(null)
    const home = await sshApi.sftpRealpath(connectionId, '.')
    if (session !== activeSession.current || request !== rootRequest.current) return
    if (!home.success) {
      setIsLoadingRoot(false)
      setError(home.error)
      return
    }
    await loadDirectory(home.data)
  }, [connectionId, session, loadDirectory])

  useEffect(() => {
    if (connectionId) void openHome()
  }, [connectionId, openHome])

  const toggleDirectory = useCallback(
    async (path: string) => {
      if (!connectionId) return
      if (expandedDirs.has(path)) {
        setExpandedDirs((prev) => {
          const next = new Set(prev)
          next.delete(path)
          return next
        })
        return
      }
      setLoadingDirs((prev) => new Set(prev).add(path))
      const rootAtStart = rootRequest.current
      const result = await sshApi.sftpListDir(connectionId, path)
      if (session !== activeSession.current) return
      setLoadingDirs((prev) => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
      // The root was reloaded meanwhile (refresh, navigation): this listing
      // belongs to a tree that is gone.
      if (rootAtStart !== rootRequest.current) return
      if (result.success) {
        setError(null)
        setChildEntries((prev) => new Map(prev).set(path, result.data))
        setExpandedDirs((prev) => new Set(prev).add(path))
      } else {
        setError(result.error)
      }
    },
    [connectionId, session, expandedDirs]
  )

  const refresh = useCallback(() => {
    if (currentPath) void loadDirectory(currentPath)
    else void openHome()
  }, [currentPath, loadDirectory, openHome])

  /** Re-list an expanded folder in place (after an upload into it), keeping the tree open. */
  const reloadChildren = useCallback(
    async (path: string) => {
      if (!connectionId) return
      const rootAtStart = rootRequest.current
      const result = await sshApi.sftpListDir(connectionId, path)
      if (session !== activeSession.current || rootAtStart !== rootRequest.current) return
      if (result.success) setChildEntries((prev) => new Map(prev).set(path, result.data))
    },
    [connectionId, session]
  )

  return {
    connectionId,
    currentPath,
    entries,
    expandedDirs,
    childEntries,
    loadingDirs,
    isLoadingRoot,
    error,
    loadDirectory,
    openHome,
    toggleDirectory,
    refresh,
    reloadChildren
  }
}

export type SftpBrowser = ReturnType<typeof useSftpBrowser>
