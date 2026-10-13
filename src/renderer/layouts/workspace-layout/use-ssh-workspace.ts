import { useCallback, useEffect } from 'react'
import { toast } from 'sonner'
import { openSSHSession } from '@/lib/ssh-sessions'
import { isTauriContext } from '@/lib/tauri-runtime'
import {
  useActiveSSHProfile,
  useActiveSSHProfileId,
  useActiveSSHSession,
  useSSHActions,
  useSSHProfiles,
  useSSHWorkspaceOpen
} from '@/stores/ssh-store'

/** SSH wiring for the workspace layout: workspace state and host entry points. */
export function useSSHWorkspace() {
  const sshProfiles = useSSHProfiles()
  const workspaceOpen = useSSHWorkspaceOpen()
  const activeSSHProfileId = useActiveSSHProfileId()
  const activeSSHProfile = useActiveSSHProfile()
  const activeSSHSession = useActiveSSHSession()
  const { loadProfiles, selectProfile } = useSSHActions()

  useEffect(() => {
    void loadProfiles()
  }, [loadProfiles])

  /** Open a new session tab for a host (desktop). */
  const handleSSHConnect = useCallback(
    (profileId: string) => {
      if (!isTauriContext()) {
        selectProfile(profileId)
        toast.info('SSH connections run in the Termul desktop app.')
        return
      }
      openSSHSession(profileId)
    },
    [selectProfile]
  )

  return {
    sshProfiles,
    workspaceOpen,
    activeSSHProfileId,
    activeSSHProfile,
    activeSSHSession,
    /** Open the SSH workspace on a host; `null` closes the workspace. */
    selectSSHProfile: selectProfile,
    handleSelectSSHProfile: selectProfile,
    handleSSHConnect
  }
}

export type SSHWorkspaceState = ReturnType<typeof useSSHWorkspace>
