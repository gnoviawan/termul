import type { DetectedShells } from '@shared/types/ipc.types'
import type { ProjectTemplate } from '@shared/types/project-template.types'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, ChevronRight, X } from 'lucide-react'
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { basename } from '@/components/chat/chat-attachments'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { reconcileProjectWorktreesNow } from '@/hooks/use-projects-persistence'
import { dialogApi, filesystemApi, gitApi, shellApi } from '@/lib/api'
import { availableColors, getColorClasses } from '@/lib/colors'
import { BUILT_IN_TEMPLATES, scaffoldProject } from '@/lib/project-templates'
import { isTauriContext } from '@/lib/tauri-runtime'
import { cn } from '@/lib/utils'
import { useDefaultProjectColor } from '@/stores/app-settings-store'
import { useProjectStore } from '@/stores/project-store'
import type { EnvVariable, Project, ProjectColor } from '@/types/project'

interface NewProjectModalProps {
  isOpen: boolean
  onClose: () => void
  onCreateProject: (
    name: string,
    color: ProjectColor,
    path?: string,
    defaultShell?: string,
    envVars?: EnvVariable[]
  ) => Project | undefined
}

export function NewProjectModal({ isOpen, onClose, onCreateProject }: NewProjectModalProps) {
  const defaultColor = useDefaultProjectColor() as ProjectColor
  // Simple defaults (empty template, app default color, detected default shell,
  // no git init) with the full set of controls back under an Advanced section.
  const [name, setName] = useState('')
  const [selectedColor, setSelectedColor] = useState<ProjectColor>(defaultColor || 'blue')
  const [path, setPath] = useState('')
  const [shells, setShells] = useState<DetectedShells | null>(null)
  const [selectedShell, setSelectedShell] = useState<string>('')
  const [shellsLoading, setShellsLoading] = useState(true)
  const [selectedTemplate, setSelectedTemplate] = useState<ProjectTemplate>(BUILT_IN_TEMPLATES[0])
  const [isFolderEmpty, setIsFolderEmpty] = useState(false)
  const [initGit, setInitGit] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  // Platform-specific fallback shell
  const fallbackShell = navigator.platform.startsWith('Win') ? 'powershell' : 'bash'
  // Fetch available shells on mount (feeds the Advanced Default Terminal select).
  useEffect(() => {
    const fetchShells = async () => {
      try {
        const result = await shellApi.getAvailableShells()
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
    void fetchShells()
  }, [fallbackShell])

  // Check if chosen directory is empty (drives the Advanced git-init checkbox).
  useEffect(() => {
    const checkEmpty = async () => {
      const trimmed = path.trim()
      if (!trimmed) {
        setIsFolderEmpty(false)
        return
      }
      try {
        const result = await filesystemApi.readDirectory(trimmed)
        if (result.success && result.data) {
          setIsFolderEmpty(result.data.length === 0)
        } else {
          // If directory doesn't exist yet, treat it as empty
          setIsFolderEmpty(true)
        }
      } catch {
        setIsFolderEmpty(true)
      }
    }
    void checkEmpty()
  }, [path])

  // Reset form when the modal opens. Deps intentionally exclude
  // `shells?.default?.name`: the async shells fetch re-fires this reset after
  // mount and would wipe name/path the user (or the auto-derivation) just set.
  // Shell init is owned by the fetch effect; `shellsRef` (read without being a
  // dep) keeps the open-transition reset from discarding an already-detected
  // default from a previous open of this mounted modal.
  const shellsRef = useRef<DetectedShells | null>(null)
  shellsRef.current = shells

  useEffect(() => {
    if (isOpen) {
      setName('')
      setSelectedColor(defaultColor || 'blue')
      setPath('')
      setSelectedShell(shellsRef.current?.default?.name || fallbackShell)
      setSelectedTemplate(BUILT_IN_TEMPLATES[0])
      setIsFolderEmpty(false)
      setInitGit(false)
      setAdvancedOpen(false)
    }
  }, [isOpen, fallbackShell, defaultColor])

  // Editing the name simply sets it; the next folder change re-derives, so a
  // user-typed name persists until the folder changes again (per spec: the
  const handlePathChange = useCallback((nextPath: string) => {
    setPath(nextPath)
    // A folder change invalidates any checked git-init: the checkbox only
    // applies to the folder it was checked against (empty-directory state
    // is recomputed below by the path effect).
    setInitGit(false)
    const trimmed = nextPath.trim()
    if (!trimmed) {
      // Field cleared: never leave a stale derived name without a directory.
      setName('')
      return
    }
    // Strip trailing separators so `/home/me/app/` derives `app`, not `''`.
    const stripped = trimmed.replace(/[\\/]+$/, '')
    // Filesystem roots (`/`, `C:`, `C:\`) must not become project names — an
    // explicit check, since basename(stripped) would otherwise yield `C:`.
    const isRootPath = stripped === '' || /^[A-Za-z]:$/.test(stripped)
    const base = isRootPath ? '' : basename(stripped)
    if (base && base !== '.' && base !== '..') {
      setName(base)
    } else {
      // Root path, `.`, or `..`: clear the derived name rather than keeping
      // a stale one that no longer matches the chosen directory.
      setName('')
    }
  }, [])

  const handleSelectTemplate = useCallback(
    (template: ProjectTemplate) => {
      setSelectedTemplate(template)
      if (template.defaultShell) {
        setSelectedShell(template.defaultShell)
      } else {
        setSelectedShell(shells?.default?.name || fallbackShell)
      }
    },
    [shells, fallbackShell]
  )

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
    const trimmedName = name.trim()
    const trimmedPath = path.trim()

    if (trimmedName && trimmedPath) {
      // Use selected shell or fallback
      const shellToUse = selectedShell || fallbackShell
      // Create the project asynchronously: scaffold the selected template's
      // files and initialize git when requested. Detection of an existing
      // repo happens below (covers pointing at pre-existing repos).
      const envVarsToPass: EnvVariable[] | undefined = selectedTemplate.envVars
        ? selectedTemplate.envVars.map((ev) => ({
            key: ev.key,
            value: ev.value,
            isSecret: ev.isSecret
          }))
        : undefined

      const runScaffoldAndGit = async () => {
        // Ensure root directory exists
        const dirResult = await filesystemApi.createDirectory(trimmedPath)
        if (!dirResult.success) {
          throw new Error(dirResult.error || 'Failed to create root directory')
        }

        let gitInitSucceeded = false
        // Initialize git repository if requested. Gated on isFolderEmpty:
        // the checkbox only renders for empty folders, and if the user later
        // switches to a non-empty folder a stale `initGit` must not run git
        // init against that directory.
        if (initGit && isFolderEmpty) {
          try {
            await gitApi.init(trimmedPath)
            gitInitSucceeded = true
          } catch (err) {
            console.error('Git init failed during scaffolding:', err)
            // Continue even if git init fails, so files are still scaffolded
          }
        }

        // Scaffold template files
        if (selectedTemplate.id !== 'empty') {
          const res = await scaffoldProject(trimmedPath, trimmedName, selectedTemplate)
          if (!res.success) {
            throw new Error(res.error || 'Failed to scaffold template files')
          }
        }

        const created = onCreateProject(
          trimmedName,
          selectedColor,
          trimmedPath,
          shellToUse,
          envVarsToPass
        )
        // Detect whether the project path is a git repo (covers BOTH paths:
        // git-init'd projects AND existing git repos pointed at without init).
        // The worktree reconciler calls `worktreeApi.list(path)` — on success
        // it sets `isGitRepo: true`; on NOT_A_GIT_REPO it sets `false`. This
        // is the same path the persistence loader uses for persisted projects,
        // so session-only projects get the same detection.
        if (created?.id) {
          // Set the immediate result first (git init success → true now).
          useProjectStore.getState().updateProject(created.id, {
            isGitRepo: gitInitSucceeded
          })
          // Then detect existing .git for the non-init path. On desktop, the
          // worktree reconciler (`reconcileProjectWorktreesNow`) does this via
          // `worktreeApi.list` (Tauri command). On web, the reconciler is
          // desktop-only (AGENTS.md: gate platform-only capabilities with
          // isTauriContext()), so probe `.git` via the fs read route instead,
          // which works for non-loopback web clients.
          if (!gitInitSucceeded && trimmedPath) {
            // `.git` can be a directory (standard repo) or a file (worktree
            // / submodule pointer containing `gitdir:`). Probe both: list the
            // directory first (covers the standard case), then try reading it
            // as a text file and checking for `gitdir:` (covers pointer files
            // where /fs/ls returns READ_ERROR on a file).
            try {
              const dirResult = await filesystemApi.readDirectory(`${trimmedPath}/.git`)
              if (dirResult.success) {
                useProjectStore.getState().updateProject(created.id, { isGitRepo: true })
              } else {
                const fileResult = await filesystemApi.readFile(`${trimmedPath}/.git`)
                if (fileResult.success && fileResult.data?.content?.startsWith('gitdir:')) {
                  useProjectStore.getState().updateProject(created.id, { isGitRepo: true })
                }
              }
            } catch {
              // Not a git repo or unreadable — isGitRepo stays false.
            }
          }
          // Restore worktree state for projects created from existing
          // worktrees (desktop-only reconciler; the `.git` probe covered
          // web parity for the isGitRepo flag above).
          if (isTauriContext() && created.id) {
            void reconcileProjectWorktreesNow(created.id).catch(() => {})
          }
        }

        return { gitInitSucceeded }
      }

      const operationPromise = runScaffoldAndGit()
      toast.promise(operationPromise, {
        loading: initGit
          ? `Initializing git and scaffolding ${selectedTemplate.name}...`
          : `Scaffolding ${selectedTemplate.name}...`,
        success: (res) => {
          if (initGit) {
            return res.gitInitSucceeded
              ? `Git repository initialized and ${selectedTemplate.name} template scaffolded successfully!`
              : `${selectedTemplate.name} template scaffolded successfully! (Git initialization failed)`
          }
          return `${selectedTemplate.name} template scaffolded successfully!`
        },
        error: (err: Error) => `Setup failed: ${err.message}`
      })

      onClose()
    }
  }, [
    name,
    selectedColor,
    path,
    selectedShell,
    fallbackShell,
    selectedTemplate,
    initGit,
    onCreateProject,
    onClose
  ])

  const handleBrowse = useCallback(async () => {
    const result = await dialogApi.selectDirectory()
    if (result.success) {
      handlePathChange(result.data)
    }
  }, [handlePathChange])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' && name.trim() && path.trim()) {
        e.preventDefault()
        handleCreate()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    },
    [name, path, handleCreate, onClose]
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
            className="bg-card rounded-lg shadow-2xl w-[520px] border border-border overflow-hidden max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
          >
            {/* Header */}
            <div className="px-4 py-3 border-b border-border flex justify-between items-center bg-secondary/50 flex-shrink-0">
              <h3 className="text-sm font-semibold text-foreground">Create New Project</h3>
              <button
                onClick={onClose}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <X size={14} />
              </button>
            </div>

            <div className="p-4 space-y-4 overflow-y-auto flex-1">
              {/* Root Directory first — the flow starts with picking a folder. */}
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  Root Directory
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={path}
                    onChange={(e) => handlePathChange(e.target.value)}
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
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  Project Name
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Project"
                  className="w-full bg-secondary border border-border rounded px-3 py-1.5 text-sm text-foreground focus:ring-1 focus:ring-primary focus:border-primary outline-none placeholder-muted-foreground"
                />
              </div>

              {/* Advanced options — collapsed by default to keep the
                  common path (pick folder, confirm auto name, Create)
                  minimal. All controls restore pre-simplification behavior. */}
              <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
                <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors w-fit cursor-pointer select-none">
                  {advancedOpen ? <ChevronDown size={12} /> : <ChevronRight size={14} />}
                  Advanced options
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-4 pt-3">
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">
                      Project Template
                    </label>
                    <div className="relative">
                      <select
                        value={selectedTemplate.id}
                        onChange={(e) => {
                          const tpl = BUILT_IN_TEMPLATES.find((t) => t.id === e.target.value)
                          if (tpl) handleSelectTemplate(tpl)
                        }}
                        className="w-full appearance-none bg-secondary border border-border rounded px-3 py-1.5 pr-8 text-sm text-foreground focus:ring-1 focus:ring-primary focus:border-primary outline-none cursor-pointer"
                      >
                        {BUILT_IN_TEMPLATES.map((tpl) => (
                          <option key={tpl.id} value={tpl.id}>
                            {tpl.name}
                          </option>
                        ))}
                      </select>
                      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-muted-foreground">
                        <ChevronDown size={14} />
                      </div>
                    </div>
                    <p className="text-3xs text-muted-foreground mt-1 leading-snug">
                      {selectedTemplate.description}
                    </p>
                    {selectedTemplate.envVars && selectedTemplate.envVars.length > 0 && (
                      <div className="bg-secondary/40 border border-border/60 rounded p-2.5 mt-2">
                        <span className="text-3xs font-semibold text-muted-foreground block mb-1.5">
                          Included Environment Variables:
                        </span>
                        <div className="flex flex-wrap gap-1.5">
                          {selectedTemplate.envVars.map((ev) => (
                            <span
                              key={ev.key}
                              className="text-3xs font-mono bg-background border border-border/80 px-2 py-0.5 rounded text-secondary-foreground"
                            >
                              {ev.key}={ev.value}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
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
                    {shellsLoading ? (
                      <Skeleton className="w-full h-9 rounded" />
                    ) : (
                      <div className="relative">
                        <select
                          value={selectedShell}
                          onChange={(e) => setSelectedShell(e.target.value)}
                          className="w-full appearance-none bg-secondary border border-border rounded px-3 py-1.5 pr-8 text-sm text-foreground focus:ring-1 focus:ring-primary focus:border-primary outline-none cursor-pointer"
                        >
                          {shells?.available && shells.available.length > 0 ? (
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
                    )}
                  </div>

                  {isFolderEmpty && (
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="init-git"
                        checked={initGit}
                        onChange={(e) => setInitGit(e.target.checked)}
                        className="rounded border-border text-primary bg-secondary focus:ring-primary h-3.5 w-3.5"
                      />
                      <label
                        htmlFor="init-git"
                        className="text-xs text-muted-foreground select-none cursor-pointer"
                      >
                        Initialize Git repository in this directory
                      </label>
                    </div>
                  )}
                </CollapsibleContent>
              </Collapsible>

              {!isTauriContext() && (
                <p className="text-xs text-muted-foreground bg-muted/50 rounded px-3 py-2 leading-relaxed">
                  On the web client, this project is saved for this session only. Host-side
                  persistence requires a future update.
                </p>
              )}
            </div>

            {/* Footer */}
            <div className="px-4 py-3 bg-secondary/50 flex justify-end gap-2 border-t border-border flex-shrink-0">
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!name.trim() || !path.trim()}
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
