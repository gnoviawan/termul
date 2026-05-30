import { useState, useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { sshApi, terminalApi, createAskpassScript } from '@/lib/api'
import { isWindows } from '@/lib/platform'
import { useSSHConnections, useSSHActions } from '@/stores/ssh-store'
import { useTerminalStore } from '@/stores/terminal-store'
import type { SSHProfile, SFTPEntry } from '@shared/types/ssh.types'

export function useSSHConnection(profile: SSHProfile | null) {
  const connections = useSSHConnections()
  const connection = profile ? connections.find((c) => c.profileId === profile.id) : undefined
  const isConnected = connection?.status === 'connected'
  const isConnectingStatus = connection?.status === 'connecting'
  const connectionId = connection?.id
  const terminalStoreId = connection?.terminalId
  const {
    markConnecting,
    markDisconnected,
    updateConnectionId,
    updateConnectionStatusByProfile,
  } = useSSHActions()

  const [localTerminalPtyId, setLocalTerminalPtyId] = useState<string | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)
  const [sftpReady, setSftpReady] = useState(false)
  const [entries, setEntries] = useState<SFTPEntry[]>([])
  const [currentPath, setCurrentPath] = useState('/')
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [childEntries, setChildEntries] = useState<Map<string, SFTPEntry[]>>(new Map())
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set())
  const [isLoadingRoot, setIsLoadingRoot] = useState(false)

  const loadDirectory = useCallback(async (path: string, overrideConnectionId?: string) => {
    const id = overrideConnectionId ?? connectionId
    if (!id) return
    setIsLoadingRoot(true)
    try {
      const result = await sshApi.sftpListDir(id, path)
      if (result.success) { setEntries(result.data); setCurrentPath(path) }
      else toast.error(`Failed to load: ${result.error}`)
    } catch (error) {
      toast.error(`Failed to load: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setIsLoadingRoot(false)
    }
  }, [connectionId])

  // Stable ref for loadDirectory so effects always call latest version
  const loadDirRef = useRef(loadDirectory)
  loadDirRef.current = loadDirectory

  // Pending timers so we can cancel writes/loads on disconnect/unmount
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const restoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (writeTimerRef.current) clearTimeout(writeTimerRef.current)
    if (restoreTimerRef.current) clearTimeout(restoreTimerRef.current)
  }, [])

  // Restore terminal + SFTP when connection state becomes available (e.g. on workspace switch-back)
  useEffect(() => {
    if (!isConnected || !terminalStoreId || localTerminalPtyId) return
    const term = useTerminalStore.getState().terminals.find((t) => t.id === terminalStoreId)
    if (term?.ptyId) {
      setLocalTerminalPtyId(term.ptyId)
      if (connectionId && !connectionId.startsWith('ssh-conn-')) {
        setSftpReady(true)
        if (restoreTimerRef.current) clearTimeout(restoreTimerRef.current)
        restoreTimerRef.current = setTimeout(() => loadDirRef.current('/'), 300)
      }
    }
  }, [isConnected, terminalStoreId, localTerminalPtyId, connectionId])

  const handleConnect = useCallback(async () => {
    if (!profile) return
    if (isConnecting || isConnected) return
    setIsConnecting(true)

    try {
      // Build SSH command as a quoted string. Each argument is wrapped so that
      // Windows key paths / usernames containing spaces survive being written
      // into the shell (e.g. -i "C:\Users\John Doe\.ssh\id_rsa").
      const quoteArg = (arg: string): string => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)
      const sshArgs: string[] = ['ssh']
      sshArgs.push(`${profile.username}@${profile.host}`)
      if (profile.port !== 22) {
        sshArgs.push('-p', String(profile.port))
      }
      if (profile.authMethod === 'key' && profile.privateKeyPath) {
        sshArgs.push('-i', profile.privateKeyPath)
      }
      sshArgs.push('-o', 'StrictHostKeyChecking=accept-new')
      if (profile.authMethod === 'password') {
        sshArgs.push('-o', 'PreferredAuthentications=password')
      }
      const sshCmd = sshArgs.map(quoteArg).join(' ')

      let spawnEnv: Record<string, string> | undefined
      if (profile.authMethod === 'password' && profile.password) {
        if (isWindows) {
          // Win32-OpenSSH ignores SSH_ASKPASS for the server password prompt and
          // cannot launch a .bat helper, so auto-feeding the password into the
          // terminal does not work. The in-app SFTP/file browser (ssh2 backend)
          // still authenticates with the password; the terminal will prompt.
          toast.info('On Windows, type your password in the terminal when prompted. File browsing connects automatically.')
        } else {
          const result = await createAskpassScript(profile.password)
          if (result.success) spawnEnv = { SSH_ASKPASS: result.data, SSH_ASKPASS_REQUIRE: 'force' }
          else toast.warning(`Password helper unavailable: ${result.error}`)
        }
      }

      const spawnResult = await terminalApi.spawn({ env: spawnEnv })
      if (!spawnResult.success) { toast.error('Failed to create terminal'); return }

      const ptyId = spawnResult.data.id
      setLocalTerminalPtyId(ptyId)

      const terminalStore = useTerminalStore.getState()
      const terminal = terminalStore.addTerminal(`SSH: ${profile.name}`, `ssh-${profile.id}`, spawnResult.data.shell, spawnResult.data.cwd)
      terminalStore.setTerminalPtyId(terminal.id, ptyId)

      // Reflect the in-progress state honestly: 'connecting' until we have a
      // real success signal. The green 'connected' badge is no longer set just
      // because a local shell was spawned.
      markConnecting(profile.id, terminal.id)

      if (writeTimerRef.current) clearTimeout(writeTimerRef.current)
      writeTimerRef.current = setTimeout(() => { void terminalApi.write(ptyId, sshCmd + '\r') }, 500)

      // The ssh2/SFTP backend connection is the authoritative source of truth
      // for whether SSH actually authenticated.
      const sftpResult = await sshApi.connect(profile.id, profile.password)
      if (sftpResult.success && sftpResult.data?.id) {
        const backendId = sftpResult.data.id
        updateConnectionId(profile.id, backendId)
        updateConnectionStatusByProfile(profile.id, 'connected')
        setSftpReady(true)
        // connectionId state may not have updated within this tick; pass the id explicitly.
        void loadDirectory('/', backendId)
        toast.success(`Connected: ${profile.name}`)
      } else {
        // SSH did not authenticate. Keep the terminal open (the user can still
        // type a password manually) but tell the truth in the badge.
        const errMsg = sftpResult.success ? 'connection not established' : sftpResult.error
        updateConnectionStatusByProfile(profile.id, 'failed', errMsg)
        toast.error(`SSH connection failed: ${errMsg ?? 'unknown error'}`)
      }
    } catch (error) {
      if (profile) updateConnectionStatusByProfile(profile.id, 'failed', error instanceof Error ? error.message : String(error))
      toast.error(`Connection failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setIsConnecting(false)
    }
  }, [profile, isConnecting, isConnected, markConnecting, updateConnectionId, updateConnectionStatusByProfile, loadDirectory])

  // Called when the interactive ssh process in the PTY exits. An immediate exit
  // typically means ssh failed to connect (bad key, refused auth, ssh client
  // missing). Clear SFTP state; only downgrade the badge if we are not already
  // in a real connected state driven by the ssh2 backend.
  const handleSSHProcessExit = useCallback(() => {
    if (!profile) return
    setSftpReady(false)
    setEntries([])
    if (!isConnected) {
      updateConnectionStatusByProfile(profile.id, 'failed', 'SSH session ended')
    }
  }, [profile, isConnected, updateConnectionStatusByProfile])

  const handleDisconnect = useCallback(async () => {
    if (!profile) return
    if (writeTimerRef.current) { clearTimeout(writeTimerRef.current); writeTimerRef.current = null }
    if (restoreTimerRef.current) { clearTimeout(restoreTimerRef.current); restoreTimerRef.current = null }
    // Call backend disconnect first to clean up SSH session, SFTP channels, and
    // port forwards. Skip backend call for purely local (never-authenticated)
    // connections whose id is still the temporary 'ssh-conn-' placeholder.
    if (connection && !connection.id.startsWith('ssh-conn-')) {
      try {
        await sshApi.disconnect(connection.id)
      } catch (error) {
        console.warn('Backend disconnect failed:', error)
      }
    }
    if (localTerminalPtyId) void terminalApi.kill(localTerminalPtyId)
    markDisconnected(profile.id)
    setLocalTerminalPtyId(null)
    setSftpReady(false)
    setEntries([])
    toast.info(`Disconnected: ${profile.name}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- profile?.id and profile?.name cover the only fields used
  }, [localTerminalPtyId, connection, profile?.id, profile?.name, markDisconnected])

  const handleBrowseFiles = useCallback(async () => {
    if (!connectionId) { toast.error('Not connected — open a terminal first'); return }
    // If SFTP never came up (id still the local placeholder), retry the backend connect.
    if (connectionId.startsWith('ssh-conn-')) {
      if (!profile) return
      const sftpResult = await sshApi.connect(profile.id, profile.password)
      if (sftpResult.success && sftpResult.data?.id) {
        const backendId = sftpResult.data.id
        updateConnectionId(profile.id, backendId)
        updateConnectionStatusByProfile(profile.id, 'connected')
        setSftpReady(true)
        void loadDirectory('/', backendId)
      } else {
        const errMsg = sftpResult.success ? 'connection not established' : sftpResult.error
        toast.error(`SFTP unavailable: ${errMsg ?? 'connection not established'}`)
      }
      return
    }
    setSftpReady(true); void loadDirectory('/')
  }, [connectionId, loadDirectory, profile, updateConnectionId, updateConnectionStatusByProfile])

  const toggleDirectory = useCallback(async (dirPath: string) => {
    if (!connectionId) return
    if (expandedDirs.has(dirPath)) { setExpandedDirs((prev) => { const n = new Set(prev); n.delete(dirPath); return n }); return }
    setLoadingDirs((prev) => new Set(prev).add(dirPath))
    try {
      const result = await sshApi.sftpListDir(connectionId, dirPath)
      if (result.success) { setChildEntries((prev) => new Map(prev).set(dirPath, result.data)); setExpandedDirs((prev) => new Set(prev).add(dirPath)) }
      else toast.error(`Permission denied: ${dirPath}`)
    } catch (error) {
      toast.error(`Failed to load ${dirPath}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setLoadingDirs((prev) => { const n = new Set(prev); n.delete(dirPath); return n })
    }
  }, [connectionId, expandedDirs])

  return {
    isConnected, isConnectingStatus, connectionId, localTerminalPtyId, isConnecting,
    sftpReady, entries, currentPath, expandedDirs, childEntries, loadingDirs, isLoadingRoot,
    setLocalTerminalPtyId, setSftpReady, setEntries,
    handleConnect, handleDisconnect, handleSSHProcessExit, loadDirectory, handleBrowseFiles, toggleDirectory,
  }
}
