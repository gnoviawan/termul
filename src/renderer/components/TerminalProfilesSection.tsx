import type { DetectedShells } from '@shared/types/ipc.types'
import { Check, Edit2, Plus, Terminal, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { shellApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useTerminalProfilesStore } from '@/stores/terminal-profiles-store'
import { FONT_FAMILY_OPTIONS } from '@/types/settings'
import type { TerminalProfile } from '@/types/terminal-profile'

interface ProfileFormData {
  name: string
  shell: string
  cwd: string
  env: string // JSON string for editing
  fontFamily: string
  fontSize: number
}

const DEFAULT_FORM_DATA: ProfileFormData = {
  name: '',
  shell: '',
  cwd: '',
  env: '{}',
  fontFamily: '',
  fontSize: 14
}

export function TerminalProfilesSection(): React.JSX.Element {
  const profiles = useTerminalProfilesStore((state) => state.profiles)
  const addProfile = useTerminalProfilesStore((state) => state.addProfile)
  const updateProfile = useTerminalProfilesStore((state) => state.updateProfile)
  const deleteProfile = useTerminalProfilesStore((state) => state.deleteProfile)

  const [availableShells, setAvailableShells] = useState<DetectedShells | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formData, setFormData] = useState<ProfileFormData>(DEFAULT_FORM_DATA)
  const [formError, setFormError] = useState<string | null>(null)

  // Load available shells
  useEffect(() => {
    async function loadShells(): Promise<void> {
      try {
        const result = await shellApi.getAvailableShells()
        if (result.success && result.data) {
          setAvailableShells(result.data)
        }
      } catch {
        // Silently fail
      }
    }
    void loadShells()
  }, [])

  const resetForm = () => {
    setFormData(DEFAULT_FORM_DATA)
    setFormError(null)
    setIsCreating(false)
    setEditingId(null)
  }

  const handleCreate = () => {
    setIsCreating(true)
    setFormData(DEFAULT_FORM_DATA)
  }

  const handleEdit = (profile: TerminalProfile) => {
    setEditingId(profile.id)
    setFormData({
      name: profile.name,
      shell: profile.shell ?? '',
      cwd: profile.cwd ?? '',
      env: profile.env ? JSON.stringify(profile.env, null, 2) : '{}',
      fontFamily: profile.font?.family ?? '',
      fontSize: profile.font?.size ?? 14
    })
    setFormError(null)
  }

  const handleSave = () => {
    // Validate name
    if (!formData.name.trim()) {
      setFormError('Profile name is required')
      return
    }

    // Validate env JSON
    let env: Record<string, string> | undefined
    if (formData.env.trim() && formData.env.trim() !== '{}') {
      try {
        const parsed = JSON.parse(formData.env)
        if (typeof parsed !== 'object' || Array.isArray(parsed)) {
          setFormError('Environment variables must be a JSON object')
          return
        }
        env = parsed
      } catch {
        setFormError('Invalid JSON for environment variables')
        return
      }
    }

    const profileData = {
      name: formData.name.trim(),
      shell: formData.shell || undefined,
      cwd: formData.cwd || undefined,
      env,
      font:
        formData.fontFamily || formData.fontSize !== 14
          ? {
              family: formData.fontFamily || undefined,
              size: formData.fontSize
            }
          : undefined
    }

    if (isCreating) {
      addProfile(profileData)
    } else if (editingId) {
      updateProfile(editingId, profileData)
    }

    resetForm()
  }

  const handleDelete = (id: string) => {
    deleteProfile(id)
  }

  const handleCancel = () => {
    resetForm()
  }

  return (
    <section>
      <div className="flex items-start gap-6 border-b border-border pb-8">
        <div className="w-1/3 pt-1">
          <h2 className="text-lg font-medium text-foreground">Terminal Profiles</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Create reusable terminal configurations with shell, environment, and font settings.
          </p>
        </div>
        <div className="w-2/3 space-y-4">
          {/* Profile List */}
          {profiles.length > 0 && (
            <div className="space-y-2 mb-4">
              {profiles.map((profile) => (
                <div
                  key={profile.id}
                  className="flex items-center justify-between p-3 bg-secondary/30 rounded-lg border border-border"
                >
                  <div className="flex items-center gap-3">
                    <Terminal size={16} className="text-muted-foreground" />
                    <div>
                      <div className="text-sm font-medium text-foreground">{profile.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {profile.shell ?? 'Default shell'}
                        {profile.cwd && ` • ${profile.cwd}`}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleEdit(profile)}
                      className="p-1.5 rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
                      title="Edit profile"
                    >
                      <Edit2 size={14} />
                    </button>
                    <button
                      onClick={() => handleDelete(profile.id)}
                      className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                      title="Delete profile"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Create/Edit Form */}
          {(isCreating || editingId) && (
            <div className="p-4 bg-secondary/20 rounded-lg border border-border space-y-4">
              <div className="text-sm font-medium text-foreground">
                {isCreating ? 'Create New Profile' : 'Edit Profile'}
              </div>

              {formError && (
                <div className="text-xs text-destructive bg-destructive/10 p-2 rounded">
                  {formError}
                </div>
              )}

              {/* Name */}
              <div>
                <label className="block text-xs font-medium text-secondary-foreground mb-1">
                  Profile Name *
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g., Node Dev, Docker, SSH Bastion"
                  className="w-full bg-secondary/50 border border-border rounded px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
                />
              </div>

              {/* Shell */}
              <div>
                <label className="block text-xs font-medium text-secondary-foreground mb-1">
                  Shell (optional)
                </label>
                <select
                  value={formData.shell}
                  onChange={(e) => setFormData({ ...formData, shell: e.target.value })}
                  className="w-full bg-secondary/50 border border-border rounded px-2.5 py-1.5 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
                >
                  <option value="">Default Shell</option>
                  {availableShells?.available?.map((shell) => (
                    <option key={shell.name} value={shell.name}>
                      {shell.displayName}
                    </option>
                  ))}
                </select>
              </div>

              {/* Working Directory */}
              <div>
                <label className="block text-xs font-medium text-secondary-foreground mb-1">
                  Starting Directory (optional)
                </label>
                <input
                  type="text"
                  value={formData.cwd}
                  onChange={(e) => setFormData({ ...formData, cwd: e.target.value })}
                  placeholder="e.g., ~/projects/my-app"
                  className="w-full bg-secondary/50 border border-border rounded px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
                />
              </div>

              {/* Environment Variables */}
              <div>
                <label className="block text-xs font-medium text-secondary-foreground mb-1">
                  Environment Variables (JSON, optional)
                </label>
                <textarea
                  value={formData.env}
                  onChange={(e) => setFormData({ ...formData, env: e.target.value })}
                  placeholder='{"NODE_ENV": "development", "PORT": "3000"}'
                  rows={3}
                  className="w-full bg-secondary/50 border border-border rounded px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none font-mono"
                />
              </div>

              {/* Font Override */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-secondary-foreground mb-1">
                    Font Family (optional)
                  </label>
                  <select
                    value={formData.fontFamily}
                    onChange={(e) => setFormData({ ...formData, fontFamily: e.target.value })}
                    className="w-full bg-secondary/50 border border-border rounded px-2.5 py-1.5 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
                  >
                    <option value="">Use Default</option>
                    {FONT_FAMILY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-secondary-foreground mb-1">
                    Font Size: {formData.fontSize}px
                  </label>
                  <input
                    type="range"
                    min={10}
                    max={24}
                    value={formData.fontSize}
                    onChange={(e) =>
                      setFormData({ ...formData, fontSize: parseInt(e.target.value, 10) })
                    }
                    className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer accent-primary"
                  />
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 pt-2">
                <button
                  onClick={handleSave}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm font-medium hover:bg-primary/90 transition-colors"
                >
                  <Check size={14} />
                  {isCreating ? 'Create' : 'Save'}
                </button>
                <button
                  onClick={handleCancel}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-secondary text-secondary-foreground rounded text-sm font-medium hover:bg-secondary/80 transition-colors"
                >
                  <X size={14} />
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Create Button */}
          {!isCreating && !editingId && (
            <button
              onClick={handleCreate}
              className="flex items-center gap-2 px-3 py-2 bg-secondary/50 border border-border rounded-lg text-sm text-foreground hover:bg-secondary transition-colors"
            >
              <Plus size={16} />
              Create Profile
            </button>
          )}

          {profiles.length === 0 && !isCreating && (
            <p className="text-xs text-muted-foreground">
              No profiles yet. Create one to quickly launch terminals with predefined settings.
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
