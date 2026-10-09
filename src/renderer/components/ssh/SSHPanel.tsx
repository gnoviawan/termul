import type { SSHProfile } from '@shared/types/ssh.types'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Download, Eye, EyeOff, Pencil, Plus, Trash2, Wifi, WifiOff } from '@/components/icons'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  PANEL_HEADER_CLASS,
  PANEL_ICON_BUTTON_CLASS,
  QUIET_ICON_BUTTON_CLASS
} from '@/components/ui/panel-styles'
import { isTauriContext } from '@/lib/tauri-runtime'
import { cn } from '@/lib/utils'
import { useSSHActions, useSSHConnections, useSSHProfiles } from '@/stores/ssh-store'
import { SSHProfileForm } from './SSHProfileForm'
import { resolveSSHHostState, SSHHostLamp, SSHHostStateWord } from './ssh-host-status'

/** Small row action button (edit / connect / disconnect). */
const ROW_ACTION_BUTTON = `${QUIET_ICON_BUTTON_CLASS} size-6`

interface SSHPanelProps {
  onConnect?: (profileId: string) => void
  onSelectProfile?: (profileId: string) => void
  activeProfileId?: string | null
}

export function SSHPanel({
  onConnect,
  onSelectProfile,
  activeProfileId
}: SSHPanelProps): React.JSX.Element {
  const profiles = useSSHProfiles()
  const connections = useSSHConnections()
  const { loadProfiles, disconnect, importConfig, deleteProfile, selectProfile } = useSSHActions()
  // Profile form: closed when null; `profile` null = new profile.
  const [form, setForm] = useState<{ profile: SSHProfile | null } | null>(null)
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const [showCredentials, setShowCredentials] = useState(false)
  // Delete is irreversible — gate it behind a confirmation dialog (mirrors
  // ProjectChatList) instead of deleting on the first menu click.
  const [deleteConfirm, setDeleteConfirm] = useState<SSHProfile | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  useEffect(() => {
    loadProfiles()
  }, [loadProfiles])

  const handleConnect = async (profile: SSHProfile) => {
    setConnectingId(profile.id)
    try {
      if (onConnect) {
        await onConnect(profile.id)
      }
    } catch (error) {
      toast.error(`Connect failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setConnectingId(null)
    }
  }

  const handleDisconnect = async (connectionId: string, profileName: string) => {
    const success = await disconnect(connectionId)
    if (success) {
      toast.success(`Disconnected from ${profileName}`)
    }
  }

  const handleDeleteProfile = async (profile: SSHProfile) => {
    // In-flight guard: a second confirm while the first delete is still
    // running is a no-op.
    if (deletingId !== null) return
    setDeletingId(profile.id)
    try {
      // Tear down any live connection before removing the profile so no orphan
      // connection state survives the delete. A failed disconnect aborts the
      // delete — proceeding would orphan live connection state.
      const connection = getConnectionForProfile(profile.id)
      if (connection) {
        const disconnected = await disconnect(connection.id)
        if (!disconnected) {
          toast.error(`Could not disconnect from “${profile.name}” — profile not deleted`)
          return
        }
      }
      const success = await deleteProfile(profile.id)
      if (!success) {
        toast.error(`Failed to delete SSH profile “${profile.name}”`)
        return
      }
      // Clear the active selection only after the delete succeeded so a
      // failed delete never strands the user on an unselected live profile.
      if (activeProfileId === profile.id) {
        selectProfile(null)
      }
    } catch (error) {
      toast.error(
        `Failed to delete SSH profile “${profile.name}”: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      setDeletingId(null)
    }
  }

  const handleImport = async () => {
    const imported = await importConfig()
    if (imported.length > 0) {
      toast.success(`Imported ${imported.length} SSH profile(s) from ~/.ssh/config`)
    } else {
      toast.info('No new profiles found in ~/.ssh/config')
    }
  }

  const openNewProfile = () => setForm({ profile: null })

  const getConnectionForProfile = (profileId: string) =>
    connections.find((c) => c.profileId === profileId)

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className={cn(PANEL_HEADER_CLASS, 'h-9')}>
        <div className="flex items-center gap-1">
          <span className="label-panel">SSH</span>
          {/* Shows/hides user@host:port on each row (privacy). Panel visibility
              itself is toggled from the activity rail. */}
          <button
            type="button"
            onClick={() => setShowCredentials((shown) => !shown)}
            className={ROW_ACTION_BUTTON}
            title={showCredentials ? 'Hide credentials' : 'Show credentials'}
            aria-label={showCredentials ? 'Hide credentials' : 'Show credentials'}
            aria-pressed={showCredentials}
          >
            {showCredentials ? <Eye size={12} /> : <EyeOff size={12} />}
          </button>
        </div>
        <div className="flex items-center">
          <button
            type="button"
            onClick={handleImport}
            className={PANEL_ICON_BUTTON_CLASS}
            title="Import from ~/.ssh/config"
            aria-label="Import from ~/.ssh/config"
          >
            <Download size={14} />
          </button>
          <button
            type="button"
            onClick={openNewProfile}
            className={PANEL_ICON_BUTTON_CLASS}
            title="New SSH Profile"
            aria-label="New SSH Profile"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      {/* Profile List */}
      <div className="flex-1 overflow-y-auto px-2 pb-1">
        {profiles.length === 0 ? (
          <div className="flex flex-col gap-2 px-2 pb-2" data-testid="ssh-empty-state">
            <p className="text-xs text-secondary-foreground">No SSH hosts yet.</p>
            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                onClick={openNewProfile}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-popover px-2.5 text-xs font-medium text-foreground transition-colors duration-150 ease-out hover:bg-foreground/[0.03] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Plus size={12} aria-hidden="true" />
                Add host
              </button>
              <button
                type="button"
                onClick={handleImport}
                className="inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors duration-150 ease-out hover:bg-foreground/[0.03] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                Import ~/.ssh/config
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {profiles.map((profile) => {
              const connection = getConnectionForProfile(profile.id)
              const isConnecting = connectingId === profile.id
              const isConnected = connection?.status === 'connected'
              const isSelected = activeProfileId === profile.id
              const hostState = resolveSSHHostState(connection?.status, isConnecting)

              return (
                <ContextMenu key={profile.id}>
                  <ContextMenuTrigger asChild>
                    <div
                      className={cn(
                        'group flex h-10 cursor-pointer items-center gap-2.5 rounded-md px-2 transition-colors duration-150 ease-out',
                        isSelected ? 'keycap text-foreground' : 'hover:bg-foreground/[0.03]'
                      )}
                      data-selected={isSelected ? 'true' : undefined}
                      data-testid={`ssh-host-row-${profile.id}`}
                      onClick={() => onSelectProfile?.(profile.id)}
                      onDoubleClick={() => {
                        if (isTauriContext() && !isConnected && !isConnecting) {
                          handleConnect(profile)
                        }
                      }}
                    >
                      <SSHHostLamp state={hostState} />

                      {/* Profile info */}
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-xs font-medium text-foreground">
                          {profile.name}
                        </span>
                        {showCredentials && (
                          <span className="truncate font-mono text-3xs text-muted-foreground">
                            {profile.username}@{profile.host}:{profile.port}
                          </span>
                        )}
                      </div>

                      <SSHHostStateWord state={hostState} className="shrink-0" />

                      {/* Row actions (opacity reveal — stays mounted, no layout shift) */}
                      <div className="flex shrink-0 items-center gap-0.5 transition-opacity pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 group-focus-within:opacity-100">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setForm({ profile })
                          }}
                          className={ROW_ACTION_BUTTON}
                          title="Edit profile"
                        >
                          <Pencil size={12} />
                        </button>
                        {isConnected ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              if (connection) {
                                handleDisconnect(connection.id, profile.name)
                              }
                            }}
                            className={cn(
                              ROW_ACTION_BUTTON,
                              'text-destructive hover:text-destructive'
                            )}
                            title="Disconnect"
                          >
                            <WifiOff size={12} />
                          </button>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              handleConnect(profile)
                            }}
                            className={ROW_ACTION_BUTTON}
                            title={isTauriContext() ? 'Connect' : 'SSH is desktop-only'}
                            disabled={isConnecting || !isTauriContext()}
                          >
                            <Wifi size={12} />
                          </button>
                        )}
                      </div>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-48">
                    <ContextMenuItem onSelect={() => setForm({ profile })}>
                      <Pencil className="mr-2 h-4 w-4" /> Edit Profile
                    </ContextMenuItem>
                    {isTauriContext() &&
                      (isConnected && connection ? (
                        <ContextMenuItem
                          onSelect={() => void handleDisconnect(connection.id, profile.name)}
                        >
                          <WifiOff className="mr-2 h-4 w-4" /> Disconnect
                        </ContextMenuItem>
                      ) : (
                        <ContextMenuItem
                          disabled={hostState === 'connecting' || hostState === 'reconnecting'}
                          onSelect={() => void handleConnect(profile)}
                        >
                          <Wifi className="mr-2 h-4 w-4" /> Connect
                        </ContextMenuItem>
                      ))}
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      variant="destructive"
                      disabled={isConnecting}
                      onSelect={() => setDeleteConfirm(profile)}
                    >
                      <Trash2 className="mr-2 h-4 w-4" /> Delete Profile
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              )
            })}
          </div>
        )}
      </div>

      {/* Profile Form Modal */}
      {form && (
        <SSHProfileForm
          profile={form.profile}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null)
            loadProfiles()
          }}
        />
      )}

      <ConfirmDialog
        isOpen={deleteConfirm !== null}
        title="Delete SSH profile"
        message={
          deleteConfirm ? `Delete “${deleteConfirm.name}”? This action cannot be undone.` : ''
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => {
          if (deleteConfirm) {
            const profile = deleteConfirm
            setDeleteConfirm(null)
            void handleDeleteProfile(profile)
          }
        }}
        onCancel={() => setDeleteConfirm(null)}
      />
    </div>
  )
}
