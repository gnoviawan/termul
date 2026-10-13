import type { SSHProfile } from '@shared/types/ssh.types'
import { useEffect } from 'react'
import { toast } from 'sonner'
import {
  Copy,
  Download,
  Eye,
  EyeOff,
  Pencil,
  Plus,
  Server,
  Terminal,
  Trash2
} from '@/components/icons'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  FOCUS_RING_CLASS,
  PANEL_HEADER_CLASS,
  PANEL_ICON_BUTTON_CLASS,
  QUIET_ICON_BUTTON_CLASS
} from '@/components/ui/panel-styles'
import { addressLabel } from '@/lib/ssh-messages'
import { isTauriContext } from '@/lib/tauri-runtime'
import { cn } from '@/lib/utils'
import {
  SSH_HOSTS_TAB,
  useSSHActions,
  useSSHProfiles,
  useSSHSessions,
  useSSHShowAddresses
} from '@/stores/ssh-store'
import { reportImport } from './SSHHostsView'
import {
  SSHPanelDialogs,
  type SSHPanelDialogsController,
  useSSHPanelDialogs
} from './SSHPanelDialogs'
import { resolveSSHHostState, SSHHostLamp, SSHHostStateWord } from './ssh-host-status'

/** Small row action button (connect / edit). */
const ROW_ACTION_BUTTON = `${QUIET_ICON_BUTTON_CLASS} size-6`

interface SSHPanelProps {
  /** Open a new session to the host. */
  onConnect?: (profileId: string) => void
  /** Open the SSH workspace focused on the host. */
  onSelectProfile?: (profileId: string) => void
  activeProfileId?: string | null
  /** Revamp section: leading control (the collapse chevron) before the `SSH` label. */
  headerLead?: React.ReactNode
  /**
   * Host editor / delete confirm owned by a host outside this panel (the Rail
   * popover). When set, the panel only raises requests and renders no dialogs.
   */
  dialogs?: SSHPanelDialogsController
  /** Rail popover: host rows take focus and move with Up/Down. */
  focusableRows?: boolean
}

/** Compact host list for the sidebar section and the Rail popover. */
export function SSHPanel({
  onConnect,
  onSelectProfile,
  activeProfileId,
  headerLead,
  dialogs: externalDialogs,
  focusableRows = false
}: SSHPanelProps): React.JSX.Element {
  const profiles = useSSHProfiles()
  const sessions = useSSHSessions()
  const { loadProfiles, importConfig, duplicateProfile, setActiveTab, toggleShowAddresses } =
    useSSHActions()
  const showAddresses = useSSHShowAddresses()
  const ownDialogs = useSSHPanelDialogs()
  const dialogs = externalDialogs ?? ownDialogs
  const desktop = isTauriContext()

  useEffect(() => {
    void loadProfiles()
  }, [loadProfiles])

  const handleImport = async () => reportImport(await importConfig())

  const handleDuplicate = async (profile: SSHProfile) => {
    const copy = await duplicateProfile(profile.id)
    if (copy) toast.success(`Duplicated as “${copy.name}”`)
    else toast.error(`Could not duplicate “${profile.name}”`)
  }

  // Up/Down move between host rows; Enter connects, Space opens the host.
  const handleRowKeyDown = (profileId: string) => (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter') {
      e.preventDefault()
      if (desktop) onConnect?.(profileId)
      else onSelectProfile?.(profileId)
      return
    }
    if (e.key === ' ') {
      e.preventDefault()
      onSelectProfile?.(profileId)
      return
    }
    const sibling =
      e.key === 'ArrowDown'
        ? e.currentTarget.nextElementSibling
        : e.key === 'ArrowUp'
          ? e.currentTarget.previousElementSibling
          : null
    if (sibling instanceof HTMLElement) {
      e.preventDefault()
      sibling.focus()
    }
  }

  const sorted = [...profiles].sort(
    (a, b) =>
      Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || a.name.localeCompare(b.name)
  )

  return (
    <div className="flex h-full flex-col">
      <div className={cn(PANEL_HEADER_CLASS, 'h-9')}>
        <div className="flex items-center gap-1">
          {headerLead}
          <span className="label-panel">SSH</span>
          {/* Shows/hides user@host:port on each row (privacy). */}
          <button
            type="button"
            onClick={toggleShowAddresses}
            className={ROW_ACTION_BUTTON}
            title={showAddresses ? 'Hide addresses' : 'Show addresses'}
            aria-label="Show addresses"
            aria-pressed={showAddresses}
          >
            {showAddresses ? <Eye size={12} /> : <EyeOff size={12} />}
          </button>
        </div>
        <div className="flex items-center">
          <button
            type="button"
            onClick={() => setActiveTab(SSH_HOSTS_TAB)}
            className={PANEL_ICON_BUTTON_CLASS}
            title="Open SSH hosts"
            aria-label="Open SSH hosts"
          >
            <Server size={14} />
          </button>
          {desktop && (
            <button
              type="button"
              onClick={() => void handleImport()}
              className={PANEL_ICON_BUTTON_CLASS}
              title="Import from ~/.ssh/config"
              aria-label="Import from ~/.ssh/config"
            >
              <Download size={14} />
            </button>
          )}
          <button
            type="button"
            onClick={() => dialogs.openForm(null)}
            className={PANEL_ICON_BUTTON_CLASS}
            title="New host"
            aria-label="New host"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-1">
        {profiles.length === 0 ? (
          <div className="flex flex-col gap-2 px-2 pb-2" data-testid="ssh-empty-state">
            <p className="text-xs text-secondary-foreground">No SSH hosts yet.</p>
            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                onClick={() => dialogs.openForm(null)}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-popover px-2.5 text-xs font-medium text-foreground transition-colors duration-150 ease-out hover:bg-foreground/[0.03] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Plus size={12} aria-hidden="true" />
                Add host
              </button>
              {desktop && (
                <button
                  type="button"
                  onClick={() => void handleImport()}
                  className="inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors duration-150 ease-out hover:bg-foreground/[0.03] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  Import ~/.ssh/config
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {sorted.map((profile) => {
              const hostSessions = sessions.filter((s) => s.profileId === profile.id)
              const hostState = resolveSSHHostState(hostSessions)
              const isSelected = activeProfileId === profile.id
              return (
                <ContextMenu key={profile.id}>
                  <ContextMenuTrigger asChild>
                    <div
                      className={cn(
                        'group relative flex h-10 cursor-pointer items-center gap-2.5 rounded-md px-2 transition-colors duration-150 ease-out',
                        isSelected ? 'keycap text-foreground' : 'hover:bg-foreground/[0.03]',
                        focusableRows && FOCUS_RING_CLASS
                      )}
                      data-selected={isSelected ? 'true' : undefined}
                      data-testid={`ssh-host-row-${profile.id}`}
                      tabIndex={focusableRows ? 0 : undefined}
                      onKeyDown={focusableRows ? handleRowKeyDown(profile.id) : undefined}
                      onClick={() => onSelectProfile?.(profile.id)}
                      onDoubleClick={() => {
                        if (desktop) onConnect?.(profile.id)
                      }}
                      title={desktop ? 'Click to open, double-click to connect' : undefined}
                    >
                      <SSHHostLamp state={hostState} />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-xs font-medium text-foreground">
                          {profile.name}
                        </span>
                        {showAddresses && (
                          <span className="truncate font-mono text-3xs text-muted-foreground">
                            {addressLabel(profile)}
                          </span>
                        )}
                      </div>
                      {/* The actions take the state word's place on hover/focus, so
                          the name keeps the row's width (no layout shift). */}
                      <SSHHostStateWord
                        state={hostState}
                        className="shrink-0 pointer-fine:group-hover:invisible group-focus-within:invisible"
                      />
                      <div className="absolute right-2 flex items-center gap-0.5 transition-opacity pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 group-focus-within:opacity-100">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            dialogs.openForm(profile)
                          }}
                          className={ROW_ACTION_BUTTON}
                          title="Edit host"
                          aria-label={`Edit ${profile.name}`}
                        >
                          <Pencil size={12} />
                        </button>
                        {desktop && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              onConnect?.(profile.id)
                            }}
                            className={ROW_ACTION_BUTTON}
                            title={hostSessions.length > 0 ? 'Open another session' : 'Connect'}
                            aria-label={`Connect to ${profile.name}`}
                          >
                            <Terminal size={12} />
                          </button>
                        )}
                      </div>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-48">
                    {desktop && (
                      <ContextMenuItem onSelect={() => onConnect?.(profile.id)}>
                        <Terminal className="mr-2 h-4 w-4" />
                        {hostSessions.length > 0 ? 'Open another session' : 'Connect'}
                      </ContextMenuItem>
                    )}
                    <ContextMenuItem onSelect={() => dialogs.openForm(profile)}>
                      <Pencil className="mr-2 h-4 w-4" /> Edit
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => void handleDuplicate(profile)}>
                      <Copy className="mr-2 h-4 w-4" /> Duplicate
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      variant="destructive"
                      onSelect={() => dialogs.requestDelete(profile)}
                    >
                      <Trash2 className="mr-2 h-4 w-4" /> Delete
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              )
            })}
          </div>
        )}
      </div>

      {!externalDialogs && <SSHPanelDialogs controller={ownDialogs} />}
    </div>
  )
}
