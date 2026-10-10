import type { SFTPEntry } from '@shared/types/ssh.types'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useSSHConnection } from '@/hooks/use-ssh-connection'
import { sshApi } from '@/lib/api'
import {
  useActiveSSHProfile,
  useActiveSSHProfileId,
  useSSHActions,
  useSSHProfiles,
  useSSHStore
} from '@/stores/ssh-store'

/** SSH profile selection, password prompt, connection and SFTP handlers. */
export function useSSHWorkspace() {
  // SSH state
  const sshProfiles = useSSHProfiles()
  const { loadProfiles: loadSSHProfiles, selectProfile: selectSSHProfile } = useSSHActions()
  const activeSSHProfileId = useActiveSSHProfileId()
  const activeSSHProfile = useActiveSSHProfile()
  const [sshPasswordPrompt, setSSHPasswordPrompt] = useState<{
    profileId: string
    profileName: string
  } | null>(null)
  const [sshPasswordInput, setSSHPasswordInput] = useState('')
  const [sshPromptPasswords, setSSHPromptPasswords] = useState<Record<string, string>>({})
  const closeSshPasswordPrompt = useCallback(() => {
    setSSHPasswordPrompt(null)
    setSSHPasswordInput('')
  }, [])

  const sshProfileWithPassword = activeSSHProfile
    ? {
        ...activeSSHProfile,
        password: sshPromptPasswords[activeSSHProfile.id] ?? activeSSHProfile.password
      }
    : null

  const sshConn = useSSHConnection(sshProfileWithPassword)

  const handleSSHMkdir = useCallback(async () => {
    if (!sshConn.connectionId) return
    const name = prompt('New folder name:')
    if (!name) return
    const newPath = sshConn.currentPath.endsWith('/')
      ? `${sshConn.currentPath}${name}`
      : `${sshConn.currentPath}/${name}`
    try {
      const r = await sshApi.sftpMkdir(sshConn.connectionId, newPath)
      if (r.success) {
        toast.success(`Created: ${name}`)
        sshConn.loadDirectory(sshConn.currentPath)
      } else toast.error(`Failed: ${r.error}`)
    } catch (error) {
      toast.error(`Failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [sshConn.connectionId, sshConn.currentPath, sshConn.loadDirectory])

  const handleSSHCreateFile = useCallback(async () => {
    if (!sshConn.connectionId) return
    const name = prompt('New file name:')
    if (!name) return
    const newPath = sshConn.currentPath.endsWith('/')
      ? `${sshConn.currentPath}${name}`
      : `${sshConn.currentPath}/${name}`
    try {
      const r = await sshApi.sftpCreateFile(sshConn.connectionId, newPath)
      if (r.success) {
        toast.success(`Created: ${name}`)
        sshConn.loadDirectory(sshConn.currentPath)
      } else toast.error(`Failed: ${r.error}`)
    } catch (error) {
      toast.error(`Failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [sshConn.connectionId, sshConn.currentPath, sshConn.loadDirectory])

  const handleSSHDelete = useCallback(
    async (entry: SFTPEntry) => {
      if (!sshConn.connectionId) return
      if (!confirm(`Delete ${entry.entryType} "${entry.name}"?`)) return
      try {
        const r = await sshApi.sftpDelete(sshConn.connectionId, entry.path)
        if (r.success) {
          toast.success(`Deleted: ${entry.name}`)
          sshConn.loadDirectory(sshConn.currentPath)
        } else toast.error(`Delete failed: ${r.error}`)
      } catch (error) {
        toast.error(`Delete failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    [sshConn.connectionId, sshConn.currentPath, sshConn.loadDirectory]
  )

  const handleSSHRename = useCallback(
    async (entry: SFTPEntry) => {
      if (!sshConn.connectionId) return
      const newName = prompt(`Rename "${entry.name}" to:`, entry.name)
      if (!newName || newName === entry.name) return
      const pp = entry.path.substring(0, entry.path.lastIndexOf('/'))
      try {
        const r = await sshApi.sftpRename(sshConn.connectionId, entry.path, `${pp}/${newName}`)
        if (r.success) {
          toast.success(`Renamed: ${entry.name} → ${newName}`)
          sshConn.loadDirectory(sshConn.currentPath)
        } else toast.error(`Rename failed: ${r.error}`)
      } catch (error) {
        toast.error(`Rename failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    [sshConn.connectionId, sshConn.currentPath, sshConn.loadDirectory]
  )

  // Load SSH profiles on mount
  useEffect(() => {
    loadSSHProfiles()
  }, [loadSSHProfiles])

  // Reconcile real SSH connection status from the backend (heartbeat,
  // reconnect, failure). Without this the badge can only ever show the
  // optimistic state set at connect time.
  useEffect(() => {
    if (typeof sshApi?.onConnectionStatusChanged !== 'function') return
    const unlisten = sshApi.onConnectionStatusChanged((connectionId, status, error) => {
      useSSHStore.getState().updateConnectionStatus(connectionId, status, error)
    })
    return () => {
      unlisten?.()
    }
  }, [])

  const handleSelectSSHProfile = useCallback(
    (profileId: string) => {
      selectSSHProfile(profileId)
    },
    [selectSSHProfile]
  )

  // SSH - just select profile (SSH workspace handles its own connect/terminal)
  const handleSSHConnect = useCallback(
    (profileId: string) => {
      const profile = sshProfiles.find((p) => p.id === profileId)
      if (!profile) return

      if (profile.authMethod === 'password' && !profile.hasStoredPassword) {
        // No password in OS keychain — show password prompt
        setSSHPasswordPrompt({ profileId, profileName: profile.name })
        setSSHPasswordInput('')
      } else {
        // Select profile → SSH workspace handles connect
        selectSSHProfile(profileId)
      }
    },
    [sshProfiles, selectSSHProfile]
  )

  const handleSSHPasswordSubmit = useCallback(() => {
    if (!sshPasswordPrompt) return
    const password = sshPasswordInput
    setSSHPromptPasswords((prev) => ({
      ...prev,
      [sshPasswordPrompt.profileId]: password
    }))
    setSSHPasswordPrompt(null)
    setSSHPasswordInput('')
    selectSSHProfile(sshPasswordPrompt.profileId)
  }, [sshPasswordPrompt, sshPasswordInput, selectSSHProfile])

  return {
    sshProfiles,
    selectSSHProfile,
    activeSSHProfileId,
    activeSSHProfile,
    sshPasswordPrompt,
    sshPasswordInput,
    setSSHPasswordInput,
    closeSshPasswordPrompt,
    sshProfileWithPassword,
    sshConn,
    handleSSHMkdir,
    handleSSHCreateFile,
    handleSSHDelete,
    handleSSHRename,
    handleSelectSSHProfile,
    handleSSHConnect,
    handleSSHPasswordSubmit
  }
}

export type SSHWorkspaceState = ReturnType<typeof useSSHWorkspace>
