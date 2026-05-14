import { useEffect, useState } from 'react'
import { Plus, Download, Wifi, WifiOff, Loader2, Pencil, Eye, EyeOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSSHProfiles, useSSHConnections, useSSHActions } from '@/stores/ssh-store'
import { SSHProfileForm } from './SSHProfileForm'
import type { SSHProfile } from '@shared/types/ssh.types'
import { toast } from 'sonner'

interface SSHPanelProps {
  onConnect?: (profileId: string) => void
  onSelectProfile?: (profileId: string) => void
  activeProfileId?: string | null
}

export function SSHPanel({ onConnect, onSelectProfile, activeProfileId }: SSHPanelProps): React.JSX.Element {
  const profiles = useSSHProfiles()
  const connections = useSSHConnections()
  const { loadProfiles, disconnect, importConfig } = useSSHActions()
  const [showForm, setShowForm] = useState(false)
  const [editingProfile, setEditingProfile] = useState<SSHProfile | null>(null)
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const [showCredentials, setShowCredentials] = useState(false)

  useEffect(() => {
    loadProfiles()
  }, [loadProfiles])

  const handleConnect = (profile: SSHProfile) => {
    if (onConnect) {
      onConnect(profile.id)
    }
  }

  const handleDisconnect = async (connectionId: string, profileName: string) => {
    const success = await disconnect(connectionId)
    if (success) {
      toast.success(`Disconnected from ${profileName}`)
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
          <span className="text-xs tracking-wider text-sidebar-foreground uppercase">SSH</span>
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
            onClick={() => { setEditingProfile(null); setShowForm(true) }}
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
                <div
                  key={profile.id}
                  className={cn(
                    'flex items-center gap-2 px-3 py-1.5 hover:bg-sidebar-accent/50 cursor-pointer group transition-colors',
                    isConnected && 'bg-sidebar-accent/30',
                    activeProfileId === profile.id && 'bg-sidebar-accent/60 border-l-2 border-primary'
                  )}
                  onClick={() => onSelectProfile?.(profile.id)}
                  onDoubleClick={() => {
                    if (!isConnected && !isConnecting) {
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
                      <div className="text-[10px] text-muted-foreground truncate">
                        {profile.username}@{profile.host}:{profile.port}
                      </div>
                    )}
                  </div>

                  {/* Connection badge */}
                  {/* Actions (visible on hover) */}
                  <div className="hidden group-hover:flex items-center gap-0.5">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditingProfile(profile)
                        setShowForm(true)
                      }}
                      className="p-1 rounded hover:bg-sidebar-accent text-muted-foreground hover:text-foreground"
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
                        className="p-1 rounded hover:bg-destructive/20 text-destructive"
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
                        className="p-1 rounded hover:bg-sidebar-accent text-muted-foreground"
                        title="Connect"
                        disabled={isConnecting}
                      >
                        <Wifi className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </div>
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
    </div>
  )
}
