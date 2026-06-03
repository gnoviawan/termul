import type { DetectedShells } from '@shared/types/ipc.types'
import { ChevronDown, Info, Link2, Plus, RefreshCw, Save, Settings, Upload, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { NewProjectModal } from '@/components/NewProjectModal'
import { Skeleton } from '@/components/ui/skeleton'
import { dialogApi, filesystemApi, shellApi, worktreeApi } from '@/lib/api'
import { availableColors, getColorClasses } from '@/lib/colors'
import { mergeEnvVars, parseEnvFile } from '@/lib/env-parser'
import { cn } from '@/lib/utils'
import { useActiveProject, useActiveProjectId, useProjectActions } from '@/stores/project-store'
import type { EnvVariable, ProjectColor } from '@/types/project'

export default function ProjectSettings() {
  const navigate = useNavigate()
  const [isNewProjectModalOpen, setIsNewProjectModalOpen] = useState(false)
  const [isCloseConfirmOpen, setIsCloseConfirmOpen] = useState(false)
  const activeProject = useActiveProject()
  const activeProjectId = useActiveProjectId()
  const { addProject, updateProject } = useProjectActions()

  const [projectName, setProjectName] = useState(activeProject?.name || '')
  const [selectedColor, setSelectedColor] = useState<ProjectColor>(activeProject?.color || 'blue')
  const [rootPath, setRootPath] = useState(activeProject?.path || '')
  const [envVars, setEnvVars] = useState<EnvVariable[]>(activeProject?.envVars || [])
  const [shell, setShell] = useState(activeProject?.defaultShell || '')
  const [startupCommand, setStartupCommand] = useState('')
  const [hasChanges, setHasChanges] = useState(false)
  const [symlinkDirs, setSymlinkDirs] = useState<string[]>(activeProject?.symlinkDirs ?? [])
  const [symlinkLoading, setSymlinkLoading] = useState(false)
  const [availableShells, setAvailableShells] = useState<DetectedShells | null>(null)
  const [shellsLoading, setShellsLoading] = useState(true)
  const [importError, setImportError] = useState<string | null>(null)
  const [importWarnings, setImportWarnings] = useState<string | null>(null)
  // TODO: Persist these to app-settings-store (localStorage) for across-session retention
  const [skipConfirmations, setSkipConfirmations] = useState(false)
  const [skipGitignoreSelection, setSkipGitignoreSelection] = useState(false)
  const [defaultBranchPrefix, setDefaultBranchPrefix] = useState('feature/')

  // Platform-specific fallback shell
  const fallbackShell = navigator.platform.startsWith('Win') ? 'powershell' : 'bash'

  // Fetch available shells on mount
  useEffect(() => {
    const fetchShells = async () => {
      try {
        const result = await shellApi.getAvailableShells()
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

  // Tracks which project's form fields have been initialized, so a late async
  // availableShells load (which re-runs the sync effect) cannot wipe fields the
  // user — or the D5 auto-fill — has since changed.
  const symlinkInitProjectRef = useRef<string | null>(null)
  const autoFilledSymlinkRef = useRef<string | null>(null)

  // Sync state when activeProject changes
  useEffect(() => {
    if (activeProject) {
      // setShell is intentionally outside the per-project guard: availableShells
      // resolves asynchronously after mount, and the resolved default must be
      // applied when it arrives.
      setShell(activeProject.defaultShell || availableShells?.default?.name || fallbackShell)
      // Everything else initializes once per project. The effect also re-runs when
      // availableShells resolves; without this guard that late run would wipe user
      // edits (and the D5 .gitignore auto-fill) made before shells loaded.
      if (symlinkInitProjectRef.current !== activeProject.id) {
        symlinkInitProjectRef.current = activeProject.id
        setProjectName(activeProject.name)
        setSelectedColor(activeProject.color)
        setRootPath(activeProject.path || '')
        setEnvVars(activeProject.envVars || [])
        setSymlinkDirs(activeProject.symlinkDirs ?? [])
        setHasChanges(false)
      }
    }
  }, [activeProject, availableShells?.default?.name, fallbackShell])

  // D5: default worktree symlinks ON. For a git project that has never configured
  // symlink dirs, pre-fill them from .gitignore so fresh worktrees inherit shared
  // deps (e.g. node_modules) and don't break with "module not found". Runs once per
  // project and never overwrites a list the user has already configured (non-empty).
  useEffect(() => {
    const proj = activeProject
    if (!proj?.path || !proj.isGitRepo) return
    if ((proj.symlinkDirs ?? []).length > 0) return
    if (autoFilledSymlinkRef.current === proj.id) return

    let cancelled = false
    const projId = proj.id
    const projPath = proj.path
    void (async () => {
      try {
        const result = await worktreeApi.parseGitignore(projPath)
        // Bail if the effect was cleaned up (project switched / unmounted). Cleanup
        // sets `cancelled`, so this is sufficient on its own.
        if (cancelled) return
        if (result.success && result.data) {
          const dirs = result.data.filter((d) => d.exists).map((d) => d.dirName)
          if (dirs.length > 0) {
            // Mark done only after a successful fill so a cancelled StrictMode
            // double-invoke doesn't suppress the real run.
            autoFilledSymlinkRef.current = projId
            setSymlinkDirs(dirs)
            setHasChanges(true)
          }
        }
      } catch {
        // Best-effort: leave the list empty if .gitignore can't be parsed.
      }
    })()
    return () => {
      cancelled = true
    }
    // Keyed on project identity only: this must run once per project selection and
    // not re-fire when other activeProject fields change (which would re-parse and
    // fight user edits).
  }, [activeProject?.id, activeProject?.path, activeProject?.isGitRepo, activeProject])

  const handleSave = () => {
    if (activeProject) {
      const normalizedEnvVars = envVars
        .map((envVar) => ({
          ...envVar,
          key: envVar.key.trim()
        }))
        .filter((envVar) => envVar.key !== '')

      // Normalize symlinkDirs: trim whitespace and remove empty/whitespace-only entries
      const normalizedSymlinkDirs = symlinkDirs.map((d) => d.trim()).filter((d) => d.length > 0)

      updateProject(activeProject.id, {
        name: projectName,
        color: selectedColor,
        path: rootPath,
        envVars: normalizedEnvVars,
        defaultShell: shell,
        symlinkDirs: normalizedSymlinkDirs
      })
      setEnvVars(normalizedEnvVars)
      setSymlinkDirs(normalizedSymlinkDirs)
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

  const addSymlinkDir = () => {
    setSymlinkDirs([...symlinkDirs, ''])
    setHasChanges(true)
  }

  const removeSymlinkDir = (index: number) => {
    setSymlinkDirs(symlinkDirs.filter((_, i) => i !== index))
    setHasChanges(true)
  }

  const updateSymlinkDir = (index: number, value: string) => {
    const newDirs = [...symlinkDirs]
    newDirs[index] = value
    setSymlinkDirs(newDirs)
    setHasChanges(true)
  }

  const syncFromGitignore = async () => {
    if (!activeProject?.path) return
    setSymlinkLoading(true)
    try {
      const result = await worktreeApi.parseGitignore(activeProject.path)
      if (result.success && result.data) {
        const existing = new Set(symlinkDirs.filter((d) => d !== ''))
        const newDirs = result.data
          .filter((d) => d.exists && !existing.has(d.dirName))
          .map((d) => d.dirName)
        if (newDirs.length > 0) {
          // Merge: add new dirs that aren't already in the list
          setSymlinkDirs([...symlinkDirs.filter((d) => d !== ''), ...newDirs])
          setHasChanges(true)
        }
      }
    } catch {
      // Best-effort
    } finally {
      setSymlinkLoading(false)
    }
  }

  const handleImportEnvFile = async () => {
    // Capture the current project ID to detect concurrent project switches
    const projectIdAtStart = activeProjectId

    setImportError(null)
    setImportWarnings(null)

    const fileResult = await dialogApi.selectFile({
      filters: [{ name: 'Environment Files', extensions: ['env'] }],
      title: 'Select .env File'
    })

    // Check if project switched during dialog
    if (projectIdAtStart !== activeProjectId) {
      return
    }

    if (!fileResult.success) {
      // User cancelled - not an error
      return
    }

    const readResult = await filesystemApi.readFile(fileResult.data)

    // Check if project switched during file read
    if (projectIdAtStart !== activeProjectId) {
      return
    }

    if (!readResult.success) {
      setImportError(`Failed to read file: ${readResult.error}`)
      return
    }

    const parseResult = parseEnvFile(readResult.data.content)

    if (parseResult.vars.length === 0 && parseResult.invalidLines.length === 0) {
      setImportError('The .env file is empty.')
      return
    }

    // Merge with existing env vars using functional update to avoid stale state
    setEnvVars((prevEnvVars) => mergeEnvVars(prevEnvVars, parseResult.vars))
    setHasChanges(true)

    // Show warnings for invalid lines if any
    if (parseResult.invalidLines.length > 0) {
      const warningDetails = parseResult.invalidLines
        .slice(0, 3)
        .map((l) => `Line ${l.line}: ${l.content}`)
        .join('\n')
      const moreCount =
        parseResult.invalidLines.length > 3 ? ` (+${parseResult.invalidLines.length - 3} more)` : ''
      setImportWarnings(
        `Imported ${parseResult.vars.length} variables.\nSkipped ${parseResult.invalidLines.length} invalid line(s):\n${warningDetails}${moreCount}`
      )
    }
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
          <button
            onClick={() => {
              if (hasChanges) {
                setIsCloseConfirmOpen(true)
              } else {
                navigate('/')
              }
            }}
            className="group flex items-center justify-center h-8 w-8 rounded-md hover:bg-secondary transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            title="Close"
            aria-label="Close project settings"
          >
            <X size={18} className="text-muted-foreground group-hover:text-foreground" />
          </button>
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
                          const result = await dialogApi.selectDirectory()
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
                    Secrets and config injected into your shell session. Secret values are cleared
                    on app restart until secure storage is added.
                  </p>
                  <button
                    onClick={addEnvVar}
                    className="mt-4 text-xs flex items-center text-primary hover:text-primary/80 font-medium transition-colors"
                  >
                    <Plus size={14} className="mr-1" /> Add Variable
                  </button>
                  <button
                    onClick={handleImportEnvFile}
                    className="mt-2 text-xs flex items-center text-primary hover:text-primary/80 font-medium transition-colors"
                  >
                    <Upload size={14} className="mr-1" /> Import from .env
                  </button>
                  {importError && <p className="mt-2 text-xs text-destructive">{importError}</p>}
                  {importWarnings && (
                    <p className="mt-2 text-xs text-yellow-600 dark:text-yellow-400 whitespace-pre-line">
                      {importWarnings}
                    </p>
                  )}
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

            {/* Worktree Symlink Directories Section */}
            <section>
              <div className="flex items-start gap-6">
                <div className="w-1/3 pt-1">
                  <h2 className="text-lg font-medium text-foreground">Worktree Symlinks</h2>
                  <p className="text-sm text-muted-foreground mt-1">
                    Directories to symlink from the project root into worktrees. This allows shared
                    dependencies (like{' '}
                    <code className="text-xs bg-secondary/50 px-1 rounded">node_modules</code>)
                    across worktrees without reinstalling.
                  </p>
                  <div className="mt-4 space-y-2">
                    <button
                      onClick={() => void syncFromGitignore()}
                      disabled={symlinkLoading || !activeProject?.isGitRepo}
                      className="text-xs flex items-center text-primary hover:text-primary/80 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <RefreshCw
                        size={14}
                        className={`mr-1 ${symlinkLoading ? 'animate-spin' : ''}`}
                      />
                      Sync from .gitignore
                    </button>
                    <button
                      onClick={addSymlinkDir}
                      className="text-xs flex items-center text-primary hover:text-primary/80 font-medium transition-colors"
                    >
                      <Plus size={14} className="mr-1" /> Add Directory
                    </button>
                  </div>
                </div>
                <div className="w-2/3">
                  <div className="bg-secondary/30 rounded-lg border border-border p-3 space-y-2">
                    {symlinkDirs.length === 0 ? (
                      <p className="text-xs text-muted-foreground text-center py-4">
                        No symlink directories configured. Click "Sync from .gitignore" to
                        auto-detect.
                      </p>
                    ) : (
                      symlinkDirs.map((dir, index) => (
                        <div key={index} className="flex items-center gap-2">
                          <Link2 size={12} className="text-muted-foreground flex-shrink-0" />
                          <input
                            type="text"
                            value={dir}
                            onChange={(e) => updateSymlinkDir(index, e.target.value)}
                            placeholder="e.g. node_modules"
                            className="flex-1 bg-secondary/50 border border-border rounded px-2 py-1 text-sm font-mono text-foreground focus:ring-1 focus:ring-primary outline-none placeholder-muted-foreground"
                          />
                          <button
                            onClick={() => removeSymlinkDir(index)}
                            className="text-muted-foreground hover:text-destructive p-1 rounded transition-colors"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </section>

            {/* Emergency Mode & Expert Workflows Section */}
            <section>
              <div className="flex items-start gap-6">
                <div className="w-1/3 pt-1">
                  <h2 className="text-lg font-medium text-foreground">Emergency Mode</h2>
                  <p className="text-sm text-muted-foreground mt-1">
                    Power-user workflow settings for incident response and rapid worktree
                    operations.
                  </p>
                </div>
                <div className="w-2/3">
                  <div className="bg-secondary/30 rounded-lg border border-border p-4 space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-foreground">
                          Skip Confirmation Dialogs
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Bypass non-essential prompts during worktree operations.
                        </p>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          className="sr-only peer"
                          checked={skipConfirmations}
                          onChange={(e) => {
                            setSkipConfirmations(e.target.checked)
                            setHasChanges(true)
                          }}
                        />
                        <div className="w-9 h-5 bg-secondary rounded-full peer peer-checked:bg-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-popover after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div>
                      </label>
                    </div>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-foreground">
                          Skip .gitignore Selection
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Use default symlink settings when creating worktrees.
                        </p>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          className="sr-only peer"
                          checked={skipGitignoreSelection}
                          onChange={(e) => {
                            setSkipGitignoreSelection(e.target.checked)
                            setHasChanges(true)
                          }}
                        />
                        <div className="w-9 h-5 bg-secondary rounded-full peer peer-checked:bg-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-popover after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div>
                      </label>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-foreground mb-1">
                        Default Branch Prefix
                      </label>
                      <input
                        type="text"
                        value={defaultBranchPrefix}
                        onChange={(e) => {
                          setDefaultBranchPrefix(e.target.value)
                          setHasChanges(true)
                        }}
                        placeholder="feature/"
                        className="w-full bg-secondary/50 border border-border rounded-md px-3 py-2 text-sm font-mono text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        Prefix for new branch naming (e.g. "feature/", "hotfix/").
                      </p>
                    </div>
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

      <ConfirmDialog
        isOpen={isCloseConfirmOpen}
        title="Unsaved Changes"
        message={`You have unsaved changes in ${activeProject?.name ?? 'this project'}. Leaving will discard them.`}
        confirmLabel="Leave"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => {
          setIsCloseConfirmOpen(false)
          navigate('/')
        }}
        onCancel={() => setIsCloseConfirmOpen(false)}
      />
    </>
  )
}
