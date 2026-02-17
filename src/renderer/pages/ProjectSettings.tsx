import { useState, useEffect } from 'react'
import { Settings, Save, Info, Plus, X, ChevronDown } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { NewProjectModal } from '@/components/NewProjectModal'
import {
  useProjects,
  useActiveProject,
  useActiveProjectId,
  useProjectActions
} from '@/stores/project-store'
import { availableColors, getColorClasses } from '@/lib/colors'
import type { ProjectColor, EnvVariable } from '@/types/project'
import type { DetectedShells } from '@shared/types/ipc.types'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'

export default function ProjectSettings() {
  const navigate = useNavigate()
  const [isNewProjectModalOpen, setIsNewProjectModalOpen] = useState(false)
  const activeProject = useActiveProject()
  const activeProjectId = useActiveProjectId()
  const {
    addProject,
    updateProject
  } = useProjectActions()

  const [projectName, setProjectName] = useState(activeProject?.name || '')
  const [selectedColor, setSelectedColor] = useState<ProjectColor>(activeProject?.color || 'blue')
  const [rootPath, setRootPath] = useState(activeProject?.path || '')
  const [envVars, setEnvVars] = useState<EnvVariable[]>(activeProject?.envVars || [])
  const [shell, setShell] = useState(activeProject?.defaultShell || '')
  const [startupCommand, setStartupCommand] = useState('')
  const [hasChanges, setHasChanges] = useState(false)
  const [availableShells, setAvailableShells] = useState<DetectedShells | null>(null)
  const [shellsLoading, setShellsLoading] = useState(true)

  // Platform-specific fallback shell
  const fallbackShell = navigator.platform.startsWith('Win') ? 'powershell' : 'bash'

  // Fetch available shells on mount
  useEffect(() => {
    const fetchShells = async () => {
      try {
        const result = await window.api.shell.getAvailableShells()
        if (result.success && result.data) {
          setAvailableShells(result.data)
        }
      } catch (err) {
        console.error('Failed to detect shells:', err)
        setAvailableShells(null)
      } finally {
        setShellsLoading(false)
      }
    }
    fetchShells()
  }, [])

  // Sync state when activeProject changes
  useEffect(() => {
    if (activeProject) {
      setProjectName(activeProject.name)
      setSelectedColor(activeProject.color)
      setRootPath(activeProject.path || '')
      setEnvVars(activeProject.envVars || [])
      setShell(activeProject.defaultShell || availableShells?.default?.name || fallbackShell)
      setHasChanges(false)
    }
  }, [activeProject, availableShells?.default?.name, fallbackShell])

  const handleSave = () => {
    if (activeProject) {
      updateProject(activeProject.id, {
        name: projectName,
        color: selectedColor,
        path: rootPath,
        envVars: envVars.filter((v) => v.key.trim() !== ''),
        defaultShell: shell
      })
      setHasChanges(false)
    }
  }

  const addEnvVar = () => {
    setEnvVars([...envVars, { key: '', value: '' }])
    setHasChanges(true)
  }

  const removeEnvVar = (index: number) => {
    setEnvVars(envVars.filter((_, i) => i !== index))
    setHasChanges(true)
  }

  return (
    <>
      <main className="flex-1 flex flex-col min-w-0 h-full relative">
        {/* Header */}
        <div className="h-16 flex items-center justify-between px-8 border-b border-border bg-card flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary/10 rounded text-primary">
              <Settings size={20} />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-foreground leading-tight">
                Project Settings
              </h1>
              <p className="text-xs text-muted-foreground">
                Configuration for{' '}
                <span className="font-semibold text-secondary-foreground">
                  {activeProject?.name}
                </span>
              </p>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-8 pb-32">
          <div className="max-w-4xl mx-auto space-y-12">
            {/* General Section */}
            <section>
              <div className="flex items-start gap-6 border-b border-border pb-8">
                <div className="w-1/3 pt-1">
                  <h2 className="text-lg font-medium text-foreground">General</h2>
                  <p className="text-sm text-muted-foreground mt-1">
                    Basic project identification and location.
                  </p>
                </div>
                <div className="w-2/3 space-y-6">
                  <div>
                    <label className="block text-sm font-medium text-secondary-foreground mb-2">
                      Project Name
                    </label>
                    <input
                      type="text"
                      value={projectName}
                      onChange={(e) => {
                        setProjectName(e.target.value)
                        setHasChanges(true)
                      }}
                      className="w-full bg-secondary/50 border border-border rounded-md px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-secondary-foreground mb-2">
                      Root Directory
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={rootPath}
                        onChange={(e) => {
                          setRootPath(e.target.value)
                          setHasChanges(true)
                        }}
                        className="flex-1 bg-secondary/50 border border-border rounded-md px-3 py-2 text-sm text-foreground font-mono focus:ring-2 focus:ring-primary outline-none"
                      />
                      <button
                        onClick={async () => {
                          const result = await window.api.dialog.selectDirectory()
                          if (result.success) {
                            setRootPath(result.data)
                            setHasChanges(true)
                          }
                        }}
                        className="px-4 py-2 bg-card hover:bg-secondary border border-border rounded-md text-sm text-foreground transition-colors shadow-sm"
                      >
                        Browse
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">
                      Changing the root directory only affects new terminals.
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-secondary-foreground mb-3">
                      Color & Appearance
                    </label>
                    <div className="flex gap-2 flex-wrap">
                      {availableColors.map((color) => {
                        const colors = getColorClasses(color)
                        return (
                          <button
                            key={color}
                            onClick={() => {
                              setSelectedColor(color)
                              setHasChanges(true)
                            }}
                            className={cn(
                              'w-8 h-8 rounded-full transition-all',
                              colors.bg,
                              selectedColor === color
                                ? 'ring-2 ring-offset-2 ring-offset-background ring-current shadow-sm'
                                : 'border-2 border-transparent hover:opacity-80'
                            )}
                          />
                        )
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* Environment Variables Section */}
            <section>
              <div className="flex items-start gap-6 border-b border-border pb-8">
                <div className="w-1/3 pt-1">
                  <h2 className="text-lg font-medium text-foreground">Environment Variables</h2>
                  <p className="text-sm text-muted-foreground mt-1">
                    Secrets and config injected into your shell session.
                  </p>
                  <button
                    onClick={addEnvVar}
                    className="mt-4 text-xs flex items-center text-primary hover:text-primary/80 font-medium transition-colors"
                  >
                    <Plus size={14} className="mr-1" /> Add Variable
                  </button>
                </div>
                <div className="w-2/3">
                  <div className="bg-secondary/30 rounded-lg border border-border overflow-hidden">
                    <div className="grid grid-cols-[1fr_1.5fr_auto] gap-px bg-border">
                      <div className="bg-secondary/80 px-4 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        Key
                      </div>
                      <div className="bg-secondary/80 px-4 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        Value
                      </div>
                      <div className="bg-secondary/80 w-10"></div>

                      {envVars.map((envVar, index) => (
                        <>
                          <div key={`key-${index}`} className="bg-card p-2">
                            <input
                              type="text"
                              value={envVar.key}
                              onChange={(e) => {
                                const newVars = [...envVars]
                                newVars[index].key = e.target.value
                                setEnvVars(newVars)
                                setHasChanges(true)
                              }}
                              placeholder="KEY"
                              className="w-full bg-transparent border-none text-sm font-mono text-primary focus:ring-0 px-2 py-1"
                            />
                          </div>
                          <div key={`val-${index}`} className="bg-card p-2 relative group">
                            <input
                              type={envVar.isSecret ? 'password' : 'text'}
                              value={envVar.value}
                              onChange={(e) => {
                                const newVars = [...envVars]
                                newVars[index].value = e.target.value
                                setEnvVars(newVars)
                                setHasChanges(true)
                              }}
                              placeholder="Value"
                              className={cn(
                                'w-full bg-transparent border-none text-sm font-mono focus:ring-0 px-2 py-1',
                                envVar.isSecret ? 'text-muted-foreground' : 'text-green-400'
                              )}
                            />
                          </div>
                          <div
                            key={`action-${index}`}
                            className="bg-card flex items-center justify-center"
                          >
                            <button
                              onClick={() => removeEnvVar(index)}
                              className="text-muted-foreground hover:text-destructive p-1 rounded transition-colors"
                            >
                              <X size={18} />
                            </button>
                          </div>
                        </>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* Shell Settings Section */}
            <section>
              <div className="flex items-start gap-6">
                <div className="w-1/3 pt-1">
                  <h2 className="text-lg font-medium text-foreground">Shell Settings</h2>
                  <p className="text-sm text-muted-foreground mt-1">
                    Customize the terminal experience for this workspace.
                  </p>
                </div>
                <div className="w-2/3 space-y-6">
                  <div>
                    <label className="block text-sm font-medium text-secondary-foreground mb-2">
                      Default Shell
                    </label>
                    {shellsLoading ? (
                      <Skeleton className="w-full h-10" />
                    ) : (
                      <div className="relative">
                        <select
                          value={shell}
                          onChange={(e) => {
                            setShell(e.target.value)
                            setHasChanges(true)
                          }}
                          className="w-full appearance-none bg-secondary/50 border border-border rounded-md pl-3 pr-10 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none cursor-pointer shadow-sm"
                        >
                          {availableShells?.available && availableShells.available.length > 0 ? (
                            availableShells.available.map((s) => (
                              <option key={s.name} value={s.name}>
                                {s.displayName}
                              </option>
                            ))
                          ) : (
                            <option value="">No shells detected</option>
                          )}
                        </select>
                        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground">
                          <ChevronDown size={14} />
                        </div>
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-secondary-foreground mb-2">
                      Startup Command
                    </label>
                    <input
                      type="text"
                      value={startupCommand}
                      onChange={(e) => {
                        setStartupCommand(e.target.value)
                        setHasChanges(true)
                      }}
                      placeholder="e.g. nvm use 16"
                      className="w-full bg-secondary/50 border border-border rounded-md px-3 py-2 text-sm font-mono text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none shadow-sm"
                    />
                    <p className="text-xs text-muted-foreground mt-2">
                      Command to execute immediately when a new terminal session starts.
                    </p>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>

        {/* Save Bar */}
        {hasChanges && (
          <div className="absolute bottom-0 left-0 right-0 p-4 bg-card border-t border-border flex justify-end items-center gap-4 z-10 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)]">
            <span className="text-sm text-muted-foreground mr-auto flex items-center">
              <Info size={14} className="mr-2 text-yellow-500" />
              <span className="opacity-80">You have unsaved changes</span>
            </span>
            <button
              onClick={() => setHasChanges(false)}
              className="px-4 py-2 text-sm font-medium text-secondary-foreground hover:text-foreground hover:bg-secondary rounded transition-colors"
            >
              Discard
            </button>
            <button
              onClick={handleSave}
              className="bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium py-2 px-6 rounded shadow-lg shadow-primary/20 transition-all flex items-center"
            >
              <Save size={14} className="mr-2" />
              Save Changes
            </button>
          </div>
        )}
      </main>

      <NewProjectModal
        isOpen={isNewProjectModalOpen}
        onClose={() => setIsNewProjectModalOpen(false)}
        onCreateProject={addProject}
      />
    </>
  )
}
