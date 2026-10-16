import type { SSHProfile } from '@shared/types/ssh.types'
import { useMemo } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import {
  ShowSidePanelSlot,
  useShowSidePanelVisible
} from '@/components/shell/SidePanelVisibilityButtons'
import { WindowControls } from '@/components/shell/TopRowChrome'
import { hostLabel } from '@/lib/ssh-messages'
import { closeSSHSession, openSSHSession, requestCloseSSHSession } from '@/lib/ssh-sessions'
import { cn } from '@/lib/utils'
import {
  SSH_HOSTS_TAB,
  useSSHActions,
  useSSHActiveTab,
  useSSHPendingClose,
  useSSHProfiles,
  useSSHSelectedProfileId,
  useSSHSessions,
  useSSHStore
} from '@/stores/ssh-store'
import type { SSHHostActions } from './SSHHostRow'
import { reportImport, SSHHostsView } from './SSHHostsView'
import { SSHPanelDialogs, useSSHPanelDialogs } from './SSHPanelDialogs'
import { SSHSessionTabs, sessionLabels, sshPanelId, sshTabId } from './SSHSessionTabs'
import { SSHSessionView } from './SSHSessionView'

interface SSHWorkspaceProps {
  /**
   * The header is the window top row. `dragRegion` marks its empty space as
   * a window drag region; `windowControls` renders the window controls flush
   * at its right end; `showSidePanel` puts the Show side panel button at its
   * start while the Side panel is hidden.
   */
  topRow?: { dragRegion: boolean; windowControls: boolean; showSidePanel: boolean }
}

/** Placeholder profile for a tab whose host was deleted meanwhile. */
const REMOVED_HOST: SSHProfile = {
  id: '',
  name: 'Removed host',
  host: 'unknown',
  port: 22,
  username: 'unknown',
  authMethod: 'password',
  portForwards: []
}

/**
 * The SSH workspace: a fixed Hosts tab (the library) and one tab per
 * session. Session views stay mounted while hidden so their shells keep
 * rendering in the background.
 */
export function SSHWorkspace({ topRow }: SSHWorkspaceProps): React.JSX.Element {
  const profiles = useSSHProfiles()
  const sessions = useSSHSessions()
  const activeTab = useSSHActiveTab()
  const selectedProfileId = useSSHSelectedProfileId()
  const pendingClose = useSSHPendingClose()
  const { setActiveTab, duplicateProfile, toggleFavorite, importConfig } = useSSHActions()
  const dialogs = useSSHPanelDialogs()
  // The slot brings its own start padding, so the header drops its own.
  const showSidePanel = useShowSidePanelVisible() && Boolean(topRow?.showSidePanel)

  const profileById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles])
  const pendingSession = sessions.find((s) => s.id === pendingClose)
  const pendingLabel = pendingSession
    ? sessionLabels(sessions, profiles).get(pendingSession.id)
    : ''
  const pendingProfile = pendingSession ? profileById.get(pendingSession.profileId) : undefined

  const actions: SSHHostActions = {
    connect: (profile) => openSSHSession(profile.id),
    edit: (profile) => dialogs.openForm(profile),
    duplicate: (profile) => {
      void duplicateProfile(profile.id).then((copy) => {
        if (copy) toast.success(`Duplicated as “${copy.name}”`)
        else toast.error(`Could not duplicate “${profile.name}”`)
      })
    },
    toggleFavorite: (profile) => {
      void toggleFavorite(profile.id).then((ok) => {
        if (!ok) toast.error('Could not update favorites')
      })
    },
    remove: (profile) => dialogs.requestDelete(profile)
  }

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden rounded-xl bg-card"
      data-testid="ssh-workspace"
    >
      <div
        className={cn(
          'flex h-10 shrink-0 items-center gap-2 border-b border-border',
          !topRow && 'px-2',
          topRow && !showSidePanel && 'pl-2'
        )}
        data-tauri-drag-region={topRow?.dragRegion ? true : undefined}
      >
        {showSidePanel && <ShowSidePanelSlot />}
        <SSHSessionTabs
          sessions={sessions}
          profiles={profiles}
          activeTab={activeTab}
          onSelect={setActiveTab}
          onClose={requestCloseSSHSession}
        />
        <div
          className="h-full min-w-4 flex-1"
          data-tauri-drag-region={topRow?.dragRegion ? true : undefined}
        />
        {topRow?.windowControls && <WindowControls windowControls />}
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          role="tabpanel"
          id={sshPanelId(SSH_HOSTS_TAB)}
          aria-labelledby={sshTabId(SSH_HOSTS_TAB)}
          hidden={activeTab !== SSH_HOSTS_TAB}
          className="h-full"
        >
          <SSHHostsView
            profiles={profiles}
            sessions={sessions}
            selectedProfileId={selectedProfileId}
            actions={actions}
            onNewHost={() => dialogs.openForm(null)}
            onImport={() => void importConfig().then(reportImport)}
          />
        </div>
        {sessions.map((session) => (
          <div
            key={session.id}
            role="tabpanel"
            id={sshPanelId(session.id)}
            aria-labelledby={sshTabId(session.id)}
            hidden={activeTab !== session.id}
            className="h-full"
          >
            <SSHSessionView
              session={session}
              profile={profileById.get(session.profileId) ?? REMOVED_HOST}
              active={activeTab === session.id}
              onEditHost={(profile) => {
                if (profile.id) dialogs.openForm(profile)
              }}
            />
          </div>
        ))}
      </div>

      <SSHPanelDialogs controller={dialogs} />
      <ConfirmDialog
        isOpen={pendingSession !== undefined}
        title="Close session?"
        message={
          pendingProfile
            ? `“${pendingLabel}” on ${hostLabel(pendingProfile)} ends, and any command still running there stops.`
            : 'The shell ends, and any command still running there stops.'
        }
        confirmLabel="Close session"
        variant="danger"
        onConfirm={() => {
          const id = useSSHStore.getState().pendingClose
          useSSHStore.getState().setPendingClose(null)
          if (id) void closeSSHSession(id)
        }}
        onCancel={() => useSSHStore.getState().setPendingClose(null)}
      />
    </div>
  )
}
