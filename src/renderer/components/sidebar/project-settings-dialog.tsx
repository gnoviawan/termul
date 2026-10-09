import type { DetectedShells } from '@shared/types/ipc.types'
import { motion } from 'framer-motion'
import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { dialogApi } from '@/lib/api'
import { availableColors, getColorClasses } from '@/lib/colors'
import { cn } from '@/lib/utils'
import type { Project, ProjectColor } from '@/types/project'

export interface ProjectSettingsDialogProps {
  /** Project being edited. The dialog renders nothing when this is null. */
  projectId: string | null
  projects: Project[]
  availableShells: DetectedShells | null
  onUpdateProject: (id: string, updates: Partial<Project>) => void
  onClose: () => void
}

/**
 * Sidebar "Project Settings" dialog (name, path, colour, default shell).
 * Owns its own form state.
 */
export function ProjectSettingsDialog({
  projectId,
  projects,
  availableShells,
  onUpdateProject,
  onClose
}: ProjectSettingsDialogProps): React.JSX.Element | null {
  const isOpen = projectId !== null

  // Settings form state
  const [settingsName, setSettingsName] = useState('')
  const [settingsPath, setSettingsPath] = useState('')
  const [settingsShell, setSettingsShell] = useState('')
  const [settingsColor, setSettingsColor] = useState<ProjectColor>('blue')
  const [settingsPathLoading, setSettingsPathLoading] = useState(false)

  // Populate form when dialog opens
  useEffect(() => {
    if (isOpen) {
      const project = projects.find((p) => p.id === projectId)
      if (project) {
        setSettingsName(project.name)
        setSettingsPath(project.path || '')
        setSettingsShell(project.defaultShell || '')
        setSettingsColor(project.color || 'blue')
      }
    }
  }, [isOpen, projectId, projects])

  const handleSaveSettings = useCallback(() => {
    const name = settingsName.trim()
    if (!name || !projectId) {
      return
    }

    onUpdateProject(projectId, {
      name,
      path: settingsPath.trim() || undefined,
      defaultShell: settingsShell || undefined,
      color: settingsColor
    })
    onClose()
  }, [
    projectId,
    settingsName,
    settingsPath,
    settingsShell,
    settingsColor,
    onUpdateProject,
    onClose
  ])

  const handleBrowsePath = useCallback(async (): Promise<void> => {
    try {
      setSettingsPathLoading(true)
      const result = await dialogApi.selectDirectory()
      if (result.success && result.data) {
        setSettingsPath(result.data)
      }
    } catch (err) {
      console.error('Failed to select directory:', err)
    } finally {
      setSettingsPathLoading(false)
    }
  }, [])

  if (!isOpen) return null

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-overlay/60 backdrop-blur-sm z-50 flex items-center justify-center"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={{ duration: 0.15 }}
        className="bg-card rounded-lg shadow-2xl w-[500px] border border-border overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-border flex justify-between items-center bg-secondary/50">
          <h3 className="text-sm font-semibold text-foreground">Project Settings</h3>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Form */}
        <div className="p-6 space-y-4">
          {/* Name Field */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Project Name</label>
            <input
              type="text"
              value={settingsName}
              onChange={(e) => setSettingsName(e.target.value)}
              className="w-full bg-secondary border border-border rounded px-3 py-1.5 text-sm text-foreground focus:ring-1 focus:ring-primary outline-none placeholder-muted-foreground"
              placeholder="My Project"
            />
          </div>

          {/* Path Field */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Project Path</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={settingsPath}
                onChange={(e) => setSettingsPath(e.target.value)}
                className="flex-1 bg-secondary border border-border rounded px-3 py-1.5 text-sm text-foreground focus:ring-1 focus:ring-primary outline-none placeholder-muted-foreground"
                placeholder="No directory selected"
              />
              <button
                onClick={handleBrowsePath}
                disabled={settingsPathLoading}
                className="bg-secondary hover:bg-muted text-foreground text-xs px-3 rounded border border-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Browse
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Optional: leave empty to use default project directory
            </p>
          </div>

          {/* Color Picker */}
          <div className="space-y-2 mt-4">
            <label className="block text-xs font-medium text-muted-foreground mb-1">Color</label>
            <div className="flex gap-2">
              {availableColors.map((color) => {
                const colors = getColorClasses(color)
                return (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setSettingsColor(color)}
                    className={cn(
                      'w-6 h-6 rounded-full transition-all',
                      colors.bg,
                      settingsColor === color
                        ? 'ring-2 ring-offset-2 ring-offset-card ring-current'
                        : 'hover:opacity-80'
                    )}
                  />
                )
              })}
            </div>
          </div>

          {/* Shell Field */}
          <div className="space-y-2">
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              Default Terminal
            </label>
            {availableShells ? (
              <div className="relative">
                <select
                  value={settingsShell}
                  onChange={(e) => setSettingsShell(e.target.value)}
                  className="w-full appearance-none bg-secondary border border-border rounded px-3 py-1.5 pr-8 text-sm text-foreground focus:ring-1 focus:ring-primary focus:border-primary outline-none cursor-pointer"
                >
                  {availableShells.available.map((shell) => (
                    <option key={shell.path} value={shell.path}>
                      {shell.displayName}
                    </option>
                  ))}
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-muted-foreground">
                  <ChevronDown size={14} />
                </div>
              </div>
            ) : (
              <Skeleton className="w-full h-9 rounded" />
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-secondary/50 flex justify-end gap-2 border-t border-border">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={handleSaveSettings}>
            Save Changes
          </Button>
        </div>
      </motion.div>
    </motion.div>
  )
}
