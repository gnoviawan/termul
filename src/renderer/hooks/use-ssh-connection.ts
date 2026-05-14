import { useState, useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { sshApi, terminalApi, createAskpassScript } from '@/lib/api'
import { useSSHConnections, useSSHActions } from '@/stores/ssh-store'
import { useTerminalStore } from '@/stores/terminal-store'
import type { SSHProfile, SFTPEntry } from '@shared/types/ssh.types'

export function useSSHConnection(profile: SSHProfile) {
  const connections = useSSHConnections()
  const connection = connections.find((c) => c.profileId === profile.id)
  const isConnected = connection?.status === 'connected'
  const connectionId = connection?.id
  const terminalStoreId = connection?.terminalId
  const { markConnected, markDisconnected, updateConnectionId } = useSSHActions()

  const [localTerminalPtyId, setLocalTerminalPtyId] = useState<string | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)
  const [sftpReady, setSftpReady] = useState(false)
  const [entries, setEntries] = useState<SFTPEntry[]>([])
  const [currentPath, setCurrentPath] = useState('/')
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [childEntries, setChildEntries] = useState<Map<string, SFTPEntry[]>>(new Map())
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set())
  const [isLoadingRoot, setIsLoadingRoot] = useState(false)

  const loadDirectory = useCallback(async (path: string) => {
    if (!connectionId) return
    setIsLoadingRoot(true)
    try {
      const result = await sshApi.sftpListDir(connectionId, path)
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

  // Restore terminal + SFTP when connection state becomes available (e.g. on workspace switch-back)
  useEffect(() => {
    if (!isConnected || !terminalStoreId || localTerminalPtyId) return
    const term = useTerminalStore.getState().terminals.find((t) => t.id === terminalStoreId)
    if (term?.ptyId) {
      setLocalTerminalPtyId(term.ptyId)
      if (connectionId && !connectionId.startsWith('ssh-conn-')) {
        setSftpReady(true)
        setTimeout(() => loadDirRef.current('/'), 300)
      }
    }
  }, [isConnected, terminalStoreId, localTerminalPtyId, connectionId])

  const handleConnect = useCallback(async () => {
    if (isConnecting || isConnected) return
    setIsConnecting(true)

    try {
      let sshCmd = `ssh ${profile.username}@${profile.host}`
      if (profile.port !== 22) sshCmd += ` -p ${profile.port}`
      if (profile.authMethod === 'key' && profile.privateKeyPath) sshCmd += ` -i "${profile.privateKeyPath}"`
      sshCmd += ' -o StrictHostKeyChecking=accept-new'
      if (profile.authMethod === 'password') sshCmd += ` -o PreferredAuthentications=password`

      let spawnEnv: Record<string, string> | undefined
      if (profile.authMethod === 'password' && profile.password) {
        const result = await createAskpassScript(profile.password)
        if (result.success) spawnEnv = { SSH_ASKPASS: result.data, SSH_ASKPASS_REQUIRE: 'force' }
        else toast.warning(`Password helper unavailable: ${result.error}`)
      }

      const spawnResult = await terminalApi.spawn({ env: spawnEnv })
      if (!spawnResult.success) { toast.error('Failed to create terminal'); return }

      const ptyId = spawnResult.data.id
      setLocalTerminalPtyId(ptyId)

      const terminalStore = useTerminalStore.getState()
      const terminal = terminalStore.addTerminal(`SSH: ${profile.name}`, `ssh-${profile.id}`, spawnResult.data.shell, spawnResult.data.cwd)
      terminalStore.setTerminalPtyId(terminal.id, ptyId)
      markConnected(profile.id, terminal.id)

      setTimeout(() => { void terminalApi.write(ptyId, sshCmd + '\r') }, 500)

      const sftpResult = await sshApi.connect(profile.id, profile.password)
      if (sftpResult.success && sftpResult.data?.id) {
        updateConnectionId(profile.id, sftpResult.data.id)
        toast.success(`Connected: ${profile.name}`)
      } else if (!sftpResult.success) {
        toast.warning(`Terminal opened, but SFTP failed: ${sftpResult.error}`)
      }
    } catch (error) {
      toast.error(`Connection failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setIsConnecting(false)
    }
  }, [profile, isConnecting, isConnected, markConnected, updateConnectionId])

  const handleDisconnect = useCallback(() => {
    if (localTerminalPtyId) void terminalApi.kill(localTerminalPtyId)
    if (connection) markDisconnected(profile.id)
    setLocalTerminalPtyId(null); setSftpReady(false); setEntries([])
    toast.info(`Disconnected: ${profile.name}`)
  }, [localTerminalPtyId, connection, profile.id, profile.name, markDisconnected])

  const handleBrowseFiles = useCallback(() => {
    if (!connectionId) { toast.error('Not connected — open a terminal first'); return }
    if (connectionId.startsWith('ssh-conn-')) { toast.info('SFTP connecting... please wait'); return }
    setSftpReady(true); void loadDirectory('/')
  }, [connectionId, loadDirectory])

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
    isConnected, connectionId, localTerminalPtyId, isConnecting,
    sftpReady, entries, currentPath, expandedDirs, childEntries, loadingDirs, isLoadingRoot,
    setLocalTerminalPtyId, setSftpReady, setEntries,
    handleConnect, handleDisconnect, loadDirectory, handleBrowseFiles, toggleDirectory,
  }
}
