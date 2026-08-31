import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { type KeyboardEvent, useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { basename } from '@/components/chat/chat-attachments'
import { reconcileProjectWorktreesNow } from '@/hooks/use-projects-persistence'
import { dialogApi, filesystemApi, shellApi } from '@/lib/api'
import { isTauriContext } from '@/lib/tauri-runtime'
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
  // Simplified modal: template/env/color/shell/git controls were removed.
  // The create chain keeps running with these fixed values (empty template,
  // app default color, detected default shell, no git init).
  const selectedColor = defaultColor || 'blue'
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [selectedShell, setSelectedShell] = useState<string>('')

  // Platform-specific fallback shell
  const fallbackShell = navigator.platform.startsWith('Win') ? 'powershell' : 'bash'

  // Fetch available shells on mount (the detected default feeds onCreateProject;
  // the selector UI itself was removed from the simplified modal).
  useEffect(() => {
    const fetchShells = async () => {
      try {
        const result = await shellApi.getAvailableShells()
        if (result.success && result.data) {
          setSelectedShell(result.data.default?.name || fallbackShell)
        } else {
          // Detection failed - use fallback
          setSelectedShell(fallbackShell)
        }
      } catch (err) {
        console.error('Failed to detect shells:', err)
        setSelectedShell(fallbackShell)
      }
    }
    void fetchShells()
  }, [fallbackShell])

  // Reset form when modal opens (use defaults)
  useEffect(() => {
    if (isOpen) {
      setName('')
      setPath('')
    }
  }, [isOpen])

  // Derive the project name from the folder's basename on every path change.
  // Editing the name simply sets it; the next folder change re-derives, so a
  // user-typed name persists until the folder changes again (per spec: the
  // auto-name guarantee is the folder change, not a separate manual-edit flag).
  const handlePathChange = useCallback((nextPath: string) => {
    setPath(nextPath)
    const trimmed = nextPath.trim()
    if (!trimmed) {
      // Field cleared: never leave a stale derived name without a directory.
      setName('')
      return
    }
    // Strip trailing separators so `/home/me/app/` derives `app`, not `''`.
    const stripped = trimmed.replace(/[\\/]+$/, '')
    const base = basename(stripped)
    // basename falls back to the whole path when the last segment is empty
    // (root paths like `/` or `C:\` already stripped to ``) — keep the name.
    if (base && base !== '.' && base !== '..' && base !== trimmed) {
      setName(base)
    }
  }, [])

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

      // Create the project asynchronously: the simplified modal pins the
      // empty template (no files to scaffold) and never git-inits. Detection
      // of an existing repo happens below.
      const runCreate = async () => {
        // Ensure root directory exists
        const dirResult = await filesystemApi.createDirectory(trimmedPath)
        if (!dirResult.success) {
          throw new Error(dirResult.error || 'Failed to create root directory')
        }

        const created = onCreateProject(
          trimmedName,
          selectedColor,
          trimmedPath,
          shellToUse,
          undefined
        )
        // Detect whether the project path is a git repo (covers BOTH paths:
        // git-init'd projects AND existing git repos pointed at without init).
        // The worktree reconciler calls `worktreeApi.list(path)` — on success
        // it sets `isGitRepo: true`; on NOT_A_GIT_REPO it sets `false`. This
        // is the same path the persistence loader uses for persisted projects,
        // so session-only projects get the same detection.
        if (created?.id) {
          // Then detect existing .git for the non-init path. On desktop, the
          // worktree reconciler (`reconcileProjectWorktreesNow`) does this via
          // `worktreeApi.list` (Tauri command). On web, the reconciler is
          // desktop-only (AGENTS.md: gate platform-only capabilities with
          // isTauriContext()), so probe `.git` via the fs read route instead,
          // which works for non-loopback web clients.
          if (trimmedPath) {
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
          if (isTauriContext() && created.id) {
            void reconcileProjectWorktreesNow(created.id).catch(() => {})
          }
        }
      }

      const operationPromise = runCreate()
      toast.promise(operationPromise, {
        loading: 'Creating project...',
        success: 'Project created!',
        error: (err: Error) => `Setup failed: ${err.message}`
      })

      onClose()
    }
  }, [name, path, selectedShell, fallbackShell, selectedColor, onCreateProject, onClose])

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
