import type { SSHProfile } from '@shared/types/ssh.types'
import { Download, Eye, EyeOff, Loader2, Pencil, Plus, Trash2, Wifi, WifiOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { isTauriContext } from '@/lib/tauri-runtime'
import { cn } from '@/lib/utils'
import { useSSHActions, useSSHConnections, useSSHProfiles } from '@/stores/ssh-store'
import { SSHProfileForm } from './SSHProfileForm'

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
  const [showForm, setShowForm] = useState(false)
  const [editingProfile, setEditingProfile] = useState<SSHProfile | null>(null)
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
      if (activeProfileId === profile.id) {
        selectProfile(null)
      }
      const success = await deleteProfile(profile.id)
      if (!success) {
        toast.error(`Failed to delete SSH profile “${profile.name}”`)
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

  const getConnectionForProfile = (profileId: string) =>
    connections.find((c) => c.profileId === profileId)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="h-9 flex items-center justify-between px-3">
        <div className="flex items-center gap-1.5">
          <span className="label-section text-sidebar-foreground">SSH</span>
          <button
            onClick={() => setShowCredentials(!showCredentials)}
            className="group h-5 w-5 inline-flex items-center justify-center rounded hover:bg-sidebar-accent transition-colors"
            title={showCredentials ? 'Hide credentials' : 'Show credentials'}
          >
            {showCredentials ? (
              <Eye className="h-3 w-3 text-muted-foreground group-hover:text-foreground" />
            ) : (
              <EyeOff className="h-3 w-3 text-muted-foreground/50 group-hover:text-foreground" />
            )}
          </button>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={handleImport}
            className="group h-6 w-6 inline-flex items-center justify-center rounded-md hover:bg-sidebar-accent transition-colors"
            title="Import from ~/.ssh/config"
          >
            <Download className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground" />
          </button>
          <button
            onClick={() => {
              setEditingProfile(null)
              setShowForm(true)
            }}
            className="group h-6 w-6 inline-flex items-center justify-center rounded-md hover:bg-sidebar-accent transition-colors"
            title="New SSH Profile"
          >
            <Plus className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground" />
          </button>
        </div>
      </div>

      {/* Profile List */}
      <div className="flex-1 overflow-y-auto">
        {profiles.length === 0 ? (
          <div className="px-3 pb-2">
            <p className="text-xs text-muted-foreground">No profiles yet</p>
          </div>
        ) : (
          <div className="pb-0.5">
            {profiles.map((profile) => {
              const connection = getConnectionForProfile(profile.id)
              const isConnecting = connectingId === profile.id
              const isConnected = connection?.status === 'connected'

              return (
                <ContextMenu key={profile.id}>
                  <ContextMenuTrigger asChild>
                    <div
                      className={cn(
                        'flex items-center gap-2 px-3 py-1.5 hover:bg-sidebar-accent cursor-pointer group transition-colors',
                        isConnected && 'bg-sidebar-accent/30',
                        activeProfileId === profile.id &&
                          'bg-sidebar-accent/60 border-l-2 border-primary'
                      )}
                      onClick={() => onSelectProfile?.(profile.id)}
                      onDoubleClick={() => {
                        if (isTauriContext() && !isConnected && !isConnecting) {
                          handleConnect(profile)
                        }
                      }}
                    >
                      {/* Status dot */}
                      <div className="flex-shrink-0">
                        {isConnecting ? (
                          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-yellow-500/20">
                            <Loader2 className="h-2.5 w-2.5 text-yellow-500 animate-spin" />
                          </span>
                        ) : isConnected ? (
                          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-green-500/20">
                            <span className="h-2 w-2 rounded-full bg-green-500" />
                          </span>
                        ) : connection?.status === 'failed' ? (
                          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-red-500/20">
                            <span className="h-2 w-2 rounded-full bg-red-500" />
                          </span>
                        ) : connection?.status === 'reconnecting' ? (
                          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-orange-500/20">
                            <span className="h-2 w-2 rounded-full bg-orange-500 animate-pulse" />
                          </span>
                        ) : (
                          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-muted-foreground/10">
                            <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
                          </span>
                        )}
                      </div>

                      {/* Profile info */}
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium truncate">{profile.name}</div>
                        {showCredentials && (
                          <div className="text-3xs text-muted-foreground truncate">
                            {profile.username}@{profile.host}:{profile.port}
                          </div>
                        )}
                      </div>

                      {/* Row actions (opacity reveal — stays mounted, no layout shift) */}
                      <div className="flex shrink-0 items-center gap-0.5 transition-opacity pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 group-focus-within:opacity-100">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditingProfile(profile)
                            setShowForm(true)
                          }}
                          className="p-1 rounded hover:bg-sidebar-accent text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                          title="Edit profile"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        {isConnected ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              if (connection) {
                                handleDisconnect(connection.id, profile.name)
                              }
                            }}
                            className="p-1 rounded hover:bg-destructive/20 text-destructive focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                            title="Disconnect"
                          >
                            <WifiOff className="h-3 w-3" />
                          </button>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              handleConnect(profile)
                            }}
                            className="p-1 rounded hover:bg-sidebar-accent text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                            title={isTauriContext() ? 'Connect' : 'SSH is desktop-only'}
                            disabled={isConnecting || !isTauriContext()}
                          >
                            <Wifi className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-48">
                    <ContextMenuItem
                      onSelect={() => {
                        setEditingProfile(profile)
                        setShowForm(true)
                      }}
                    >
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
                          disabled={
                            isConnecting ||
                            connection?.status === 'connecting' ||
                            connection?.status === 'reconnecting'
                          }
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
      {showForm && (
        <SSHProfileForm
          profile={editingProfile}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false)
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
