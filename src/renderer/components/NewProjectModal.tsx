import { useState, useCallback, useEffect, KeyboardEvent } from 'react'
import { X, ChevronDown } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import type { ProjectColor } from '@/types/project'
import type { DetectedShells } from '@shared/types/ipc.types'
import { availableColors, getColorClasses } from '@/lib/colors'
import { cn } from '@/lib/utils'
import { useDefaultProjectColor } from '@/stores/app-settings-store'

interface NewProjectModalProps {
  isOpen: boolean
  onClose: () => void
  onCreateProject: (name: string, color: ProjectColor, path?: string, defaultShell?: string) => void
}

export function NewProjectModal({ isOpen, onClose, onCreateProject }: NewProjectModalProps) {
  const defaultColor = useDefaultProjectColor() as ProjectColor
  const [name, setName] = useState('')
  const [selectedColor, setSelectedColor] = useState<ProjectColor>(defaultColor || 'blue')
  const [path, setPath] = useState('')
  const [shells, setShells] = useState<DetectedShells | null>(null)
  const [selectedShell, setSelectedShell] = useState<string>('')
  const [shellsLoading, setShellsLoading] = useState(true)

  // Platform-specific fallback shell
  const fallbackShell = navigator.platform.startsWith('Win') ? 'powershell' : 'bash'

  // Fetch available shells on mount
  useEffect(() => {
    const fetchShells = async () => {
      try {
        const result = await window.api.shell.getAvailableShells()
        if (result.success && result.data) {
          setShells(result.data)
          setSelectedShell(result.data.default?.name || fallbackShell)
        } else {
          // Detection failed - use fallback
          setSelectedShell(fallbackShell)
        }
      } catch (err) {
        console.error('Failed to detect shells:', err)
        setShells(null)
        setSelectedShell(fallbackShell)
      } finally {
        setShellsLoading(false)
      }
    }
    fetchShells()
  }, [fallbackShell])

  // Reset form when modal opens (use defaults)
  useEffect(() => {
    if (isOpen) {
      setName('')
      setSelectedColor(defaultColor || 'blue')
      setPath('')
      setSelectedShell(shells?.default?.name || fallbackShell)
    }
  }, [isOpen, defaultColor, shells?.default?.name, fallbackShell])

  // Handle Escape key to close modal
  useEffect(() => {
    if (!isOpen) return

    const handleEscape = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [isOpen, onClose])

  const handleCreate = useCallback(() => {
    if (name.trim()) {
      // Use selected shell or fallback
      const shellToUse = selectedShell || fallbackShell
      onCreateProject(name.trim(), selectedColor, path || undefined, shellToUse)
      onClose()
    }
  }, [name, selectedColor, path, selectedShell, fallbackShell, onCreateProject, onClose])

  const handleBrowse = useCallback(async () => {
    const result = await window.api.dialog.selectDirectory()
    if (result.success) {
      setPath(result.data)
    }
  }, [])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' && name.trim()) {
        e.preventDefault()
        handleCreate()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    },
    [name, handleCreate, onClose]
  )

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.15 }}
            className="bg-card rounded-lg shadow-2xl w-[480px] border border-border overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
          >
            {/* Header */}
            <div className="px-4 py-3 border-b border-border flex justify-between items-center bg-secondary/50">
              <h3 className="text-sm font-semibold text-foreground">Create New Project</h3>
              <button
                onClick={onClose}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <X size={14} />
              </button>
            </div>

            {/* Content */}
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  Project Name
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Project"
                  className="w-full bg-secondary border border-border rounded px-3 py-1.5 text-sm text-foreground focus:ring-1 focus:ring-primary focus:border-primary outline-none placeholder-muted-foreground"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  Root Directory (optional)
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    placeholder="No directory selected"
                    className="flex-1 bg-secondary border border-border rounded px-3 py-1.5 text-sm text-foreground focus:ring-1 focus:ring-primary outline-none placeholder-muted-foreground"
                  />
                  <button
                    onClick={handleBrowse}
                    className="bg-secondary hover:bg-muted text-foreground text-xs px-3 rounded border border-border transition-colors"
                  >
                    Browse
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-2">
                  Color
                </label>
                <div className="flex gap-2 flex-wrap">
                  {availableColors.map((color) => {
                    const colors = getColorClasses(color)
                    return (
                      <button
                        key={color}
                        onClick={() => setSelectedColor(color)}
                        className={cn(
                          'w-6 h-6 rounded-full transition-all',
                          colors.bg,
                          selectedColor === color
                            ? 'ring-2 ring-offset-2 ring-offset-card ring-current'
                            : 'hover:opacity-80'
                        )}
                      />
                    )
                  })}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  Default Terminal
                </label>
                <div className="relative">
                  <select
                    value={selectedShell}
                    onChange={(e) => setSelectedShell(e.target.value)}
                    disabled={shellsLoading}
                    className="w-full appearance-none bg-secondary border border-border rounded px-3 py-1.5 pr-8 text-sm text-foreground focus:ring-1 focus:ring-primary focus:border-primary outline-none cursor-pointer disabled:opacity-50"
                  >
                    {shellsLoading ? (
                      <option value="">Loading shells...</option>
                    ) : shells?.available && shells.available.length > 0 ? (
                      shells.available.map((shell) => (
                        <option key={shell.name} value={shell.name}>
                          {shell.displayName}
                        </option>
                      ))
                    ) : (
                      <option value="">No shells detected</option>
                    )}
                  </select>
                  <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-muted-foreground">
                    <ChevronDown size={14} />
                  </div>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="px-4 py-3 bg-secondary/50 flex justify-end gap-2 border-t border-border">
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!name.trim()}
                className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded hover:bg-primary/90 shadow-md shadow-primary/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Create
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
