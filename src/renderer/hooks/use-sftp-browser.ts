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
  const generation = useRef(0)

  const loadDirectory = useCallback(
    async (path: string) => {
      if (!connectionId) return
      const current = generation.current
      setIsLoadingRoot(true)
      setError(null)
      const result = await sshApi.sftpListDir(connectionId, path)
      if (current !== generation.current) return
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
    [connectionId]
  )

  const openHome = useCallback(async () => {
    if (!connectionId) return
    const current = generation.current
    setIsLoadingRoot(true)
    setError(null)
    const home = await sshApi.sftpRealpath(connectionId, '.')
    if (current !== generation.current) return
    if (!home.success) {
      setIsLoadingRoot(false)
      setError(home.error)
      return
    }
    await loadDirectory(home.data)
  }, [connectionId, loadDirectory])

  // A new connection starts fresh at the login directory.
  useEffect(() => {
    generation.current += 1
    setCurrentPath(null)
    setEntries([])
    setExpandedDirs(new Set())
    setChildEntries(new Map())
    setLoadingDirs(new Set())
    setError(null)
    setIsLoadingRoot(false)
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
      const current = generation.current
      setLoadingDirs((prev) => new Set(prev).add(path))
      const result = await sshApi.sftpListDir(connectionId, path)
      if (current !== generation.current) return
      setLoadingDirs((prev) => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
      if (result.success) {
        setChildEntries((prev) => new Map(prev).set(path, result.data))
        setExpandedDirs((prev) => new Set(prev).add(path))
      } else {
        setError(result.error)
      }
    },
    [connectionId, expandedDirs]
  )

  const refresh = useCallback(() => {
    if (currentPath) void loadDirectory(currentPath)
    else void openHome()
  }, [currentPath, loadDirectory, openHome])

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
    refresh
  }
}

export type SftpBrowser = ReturnType<typeof useSftpBrowser>
