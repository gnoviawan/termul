import type { BranchInfo } from '@shared/types/ipc.types'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, GitBranch, Link2, Loader2, Search, Terminal, X } from 'lucide-react'
import { type KeyboardEvent, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '@/hooks/use-toast'
import { worktreeApi } from '@/lib/api'
import { activateAndOpenTerminal } from '@/lib/terminal-spawn'
import { cn } from '@/lib/utils'
import { randomUUID } from '@/lib/uuid'
import { useProjectActions, useProjectStore } from '@/stores/project-store'
import type { Worktree } from '@/types/project'

interface NewWorktreeModalProps {
  isOpen: boolean
  onClose: () => void
  projectId: string
}

export function NewWorktreeModal({ isOpen, onClose, projectId }: NewWorktreeModalProps) {
  const { t } = useTranslation('agents')
  const project = useProjectStore((state) => state.projects.find((p) => p.id === projectId))
  const isWorktreeOperationLocked = useProjectStore((state) => state.isWorktreeOperationLocked)
  const { addWorktree, setWorktreeOperationLock } = useProjectActions()

  // Form state
  const [branchType, setBranchType] = useState<'existing' | 'new'>('new')
  const [selectedBranch, setSelectedBranch] = useState('')
  const [newBranchName, setNewBranchName] = useState('')
  const [startRef, setStartRef] = useState('')
  const [worktreeName, setWorktreeName] = useState('')

  // Branches state
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [showRemoteBranches, setShowRemoteBranches] = useState(false)
  const [branchSearch, setBranchSearch] = useState('')
  const [branchesLoading, setBranchesLoading] = useState(false)

  // Operation state
  const [isCreating, setIsCreating] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)

  // Symlink dirs state
  const [enabledSymlinkDirs, setEnabledSymlinkDirs] = useState<Set<string>>(new Set())
  const [showSymlinkSection, setShowSymlinkSection] = useState(false)

  // Advanced (git plumbing) disclosure — collapsed by default for non-technical users
  const [showAdvanced, setShowAdvanced] = useState(false)

  const projectPath = project?.path ?? ''
  const isGitRepo = project?.isGitRepo ?? false

  // Sanitize branch name for git (replace invalid chars with dashes)
  const sanitizeBranchName = useCallback((name: string): string => {
    return name
      .replace(/[^a-zA-Z0-9/_.-]/g, '-')
      .replace(/--+/g, '-')
      .replace(/^-|-$/g, '')
  }, [])

  // Auto-fill worktree name from branch ONLY when the user hasn't named it yet.
  // Name is the primary field now; never clobber a user-entered name.
  useEffect(() => {
    if (worktreeName.trim()) return
    if (branchType === 'new' && newBranchName) {
      setWorktreeName(sanitizeBranchName(newBranchName))
    } else if (branchType === 'existing' && selectedBranch) {
      // Extract branch name after last /
      const name = selectedBranch.split('/').pop() ?? selectedBranch
      setWorktreeName(name)
    }
  }, [branchType, newBranchName, selectedBranch, worktreeName, sanitizeBranchName])

  // Reset form when modal opens
  useEffect(() => {
    if (isOpen) {
      setBranchType('new')
      setSelectedBranch('')
      setNewBranchName('')
      setStartRef('')
      setWorktreeName('')
      setBranchSearch('')
      setShowRemoteBranches(false)
      setValidationError(null)
      setIsCreating(false)
      setShowSymlinkSection(false)
      setShowAdvanced(false)

      // Initialize symlink dirs from project settings
      const projectSymlinkDirs = project?.symlinkDirs ?? []
      setEnabledSymlinkDirs(new Set(projectSymlinkDirs))
    }
  }, [isOpen, project?.symlinkDirs])

  // Keep symlink dirs in sync with project settings without resetting the form
  useEffect(() => {
    const dirs = project?.symlinkDirs ?? []
    setEnabledSymlinkDirs(new Set(dirs))
  }, [project?.symlinkDirs])

  // Fetch branches when modal opens
  useEffect(() => {
    if (!isOpen || !projectPath) return

    const fetchBranches = async () => {
      setBranchesLoading(true)
      try {
        const result = await worktreeApi.branches(projectPath)
        if (result.success && result.data) {
          setBranches(result.data)
        } else {
          setBranches([])
        }
      } catch {
        setBranches([])
      } finally {
        setBranchesLoading(false)
      }
    }
    void fetchBranches()
  }, [isOpen, projectPath])

  // Handle Escape key
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

  // Validate form
  const validate = useCallback((): string | null => {
    if (!isGitRepo) return t('newWorktree.notGitRepo')
    if (isWorktreeOperationLocked) return t('newWorktree.operationInProgress')

    // Simple path: when creating a new branch and the Advanced branch field is empty,
    // derive the branch from the worktree name.
    const effectiveNewBranch = newBranchName.trim() || worktreeName.trim()

    // Check if branch already has a worktree
    const branch =
      branchType === 'existing' ? selectedBranch : sanitizeBranchName(effectiveNewBranch)
    const existingWorktree = project?.worktrees?.find(
      (w: Worktree) => w.branch === branch || w.name === worktreeName
    )
    if (existingWorktree) {
      return t('newWorktree.worktreeExists', { branch })
    }

    if (branchType === 'new') {
      if (!effectiveNewBranch) return t('newWorktree.nameRequired')
      // A name was entered but sanitized to nothing (e.g. "---") — it's invalid, not missing.
      if (!sanitizeBranchName(effectiveNewBranch).trim()) return t('newWorktree.nameUnusable')
    } else {
      if (!selectedBranch) return t('newWorktree.selectBranch')
    }

    if (!worktreeName.trim()) return t('newWorktree.nameRequired')

    // Check for path length (Windows MAX_PATH = 260)
    const targetPath = `${projectPath}/.termul/worktrees/${worktreeName}/`
    if (targetPath.length > 240) return t('newWorktree.pathTooLong')

    return null
  }, [
    isGitRepo,
    isWorktreeOperationLocked,
    branchType,
    selectedBranch,
    newBranchName,
    worktreeName,
    project,
    sanitizeBranchName,
    projectPath,
    t
  ])

  // Pre-check before modal can proceed
  const canProceed = isGitRepo && !isWorktreeOperationLocked

  // Filter branches for search
  const filteredBranches = branches.filter((b) => {
    if (!showRemoteBranches && b.isRemote) return false
    if (branchSearch && !b.name.toLowerCase().includes(branchSearch.toLowerCase())) return false
    return true
  })

  // Local branches first, then remote
  const sortedBranches = [...filteredBranches].sort((a, b) => {
    if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1
    if (a.isCurrent) return -1
    if (b.isCurrent) return 1
    return a.name.localeCompare(b.name)
  })

  const handleCreate = useCallback(async () => {
    const error = validate()
    if (error) {
      setValidationError(error)
      return
    }

    setIsCreating(true)
    setValidationError(null)
    setWorktreeOperationLock(true)

    try {
      const branch =
        branchType === 'existing'
          ? selectedBranch
          : sanitizeBranchName(newBranchName.trim() || worktreeName.trim())

      const result = await worktreeApi.create({
        projectPath,
        name: worktreeName,
        branch,
        isNewBranch: branchType === 'new',
        startRef: startRef || undefined
      })

      if (result.success && result.data) {
        const newWorktree: Worktree = {
          id: randomUUID(),
          name: result.data.name,
          branch: result.data.branch,
          path: result.data.path,
          createdAt: new Date().toISOString()
        }
        addWorktree(projectId, newWorktree)

        // Create symlinks for enabled directories
        const enabledDirs = Array.from(enabledSymlinkDirs)
        if (enabledDirs.length > 0) {
          try {
            const symlinkResult = await worktreeApi.createSymlinks(
              projectPath,
              result.data.path,
              enabledDirs
            )
            if (symlinkResult.success && symlinkResult.data) {
              const created = symlinkResult.data.filter((r) => r.status === 'created').length
              const skipped = symlinkResult.data.filter((r) => r.status === 'skipped').length
              const failed = symlinkResult.data.filter((r) => r.status === 'failed').length
              if (failed > 0) {
                toast({
                  title: t('newWorktree.symlinkWarnings'),
                  description: t('newWorktree.symlinkWarningsDesc', { created, skipped, failed })
                })
              } else {
                toast({
                  title: t('newWorktree.created'),
                  description: t('newWorktree.createdWithSymlinks', {
                    name: result.data.name,
                    branch: result.data.branch,
                    created
                  })
                })
              }
            } else {
              // Symlink creation failed but worktree was created successfully
              toast({
                title: t('newWorktree.created'),
                description: t('newWorktree.createdSymlinkIssues', {
                  name: result.data.name,
                  branch: result.data.branch
                })
              })
            }
          } catch {
            // Symlink failure is non-blocking
            toast({
              title: t('newWorktree.created'),
              description: t('newWorktree.createdSymlinkSkipped', {
                name: result.data.name,
                branch: result.data.branch
              })
            })
          }
        } else {
          toast({
            title: t('newWorktree.created'),
            description: t('newWorktree.createdDesc', {
              name: result.data.name,
              branch: result.data.branch
            })
          })
        }

        // Land the user inside the new worktree: activate it and open a terminal there.
        // Best-effort — a spawn failure must not block the (already successful) creation.
        const outcome = await activateAndOpenTerminal(projectId, newWorktree.id, result.data.path)
        if (outcome.status === 'no-pane') {
          toast({
            title: t('newWorktree.readyNoTerminal'),
            description: t('newWorktree.noPaneDesc')
          })
        } else if (outcome.status === 'spawn-failed') {
          toast({
            title: t('newWorktree.readyNoTerminal'),
            description: outcome.error || t('newWorktree.openTerminalFailed')
          })
        }

        onClose()
      } else {
        setValidationError(!result.success ? result.error : t('newWorktree.failedToCreate'))
        toast({
          title: t('newWorktree.failedToCreate'),
          description: !result.success ? result.error : t('newWorktree.unknownError'),
          variant: 'destructive'
        })
      }
    } catch (err) {
      const msg = String(err)
      setValidationError(msg)
      toast({
        title: t('newWorktree.errorCreating'),
        description: msg,
        variant: 'destructive'
      })
    } finally {
      setIsCreating(false)
      setWorktreeOperationLock(false)
    }
  }, [
    validate,
    branchType,
    selectedBranch,
    newBranchName,
    worktreeName,
    startRef,
    projectPath,
    projectId,
    addWorktree,
    setWorktreeOperationLock,
    onClose,
    enabledSymlinkDirs,
    sanitizeBranchName,
    t
  ])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' && canProceed && worktreeName.trim()) {
        e.preventDefault()
        void handleCreate()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    },
    [canProceed, worktreeName, handleCreate, onClose]
  )

  // Path preview
  const pathPreview = projectPath
    ? `${projectPath}/.termul/worktrees/${worktreeName || t('newWorktree.pathNamePlaceholder')}/`
    : t('newWorktree.pathSelectProject')

  if (!project) return null

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
            className="bg-card rounded-lg shadow-2xl w-[520px] border border-border overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
          >
            {/* Header */}
            <div className="px-4 py-3 border-b border-border flex justify-between items-center bg-secondary/50">
              <div className="flex items-center gap-2">
                <GitBranch size={14} className="text-primary" />
                <h3 className="text-sm font-semibold text-foreground">{t('newWorktree.title')}</h3>
              </div>
              <button
                onClick={onClose}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <X size={14} />
              </button>
            </div>

            {/* Content */}
            <div className="p-4 space-y-4">
              {/* Project name (read-only) */}
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  {t('newWorktree.project')}
                </label>
                <input
                  type="text"
                  value={project.name}
                  readOnly
                  className="w-full bg-secondary/50 border border-border rounded px-3 py-1.5 text-sm text-muted-foreground cursor-not-allowed"
                />
              </div>

              {/* Worktree name — primary, only required field for the simple path */}
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  {t('newWorktree.name')}
                </label>
                <input
                  type="text"
                  value={worktreeName}
                  onChange={(e) => setWorktreeName(e.target.value)}
                  placeholder={t('newWorktree.namePlaceholder')}
                  className="w-full bg-secondary border border-border rounded px-3 py-1.5 text-sm text-foreground focus:ring-1 focus:ring-primary outline-none placeholder-muted-foreground"
                />
                <p className="text-3xs text-muted-foreground mt-0.5">{t('newWorktree.nameHint')}</p>
              </div>

              {/* Advanced (git plumbing) — collapsed by default for non-technical users */}
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                aria-expanded={showAdvanced}
              >
                <GitBranch size={12} aria-hidden="true" />
                <span>{t('newWorktree.advanced')}</span>
                <span className="text-3xs" aria-hidden="true">
                  {showAdvanced ? '▼' : '▶'}
                </span>
              </button>

              {showAdvanced && (
                <div className="space-y-4">
                  {/* Branch type toggle */}
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">
                      {t('newWorktree.branchType')}
                    </label>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setBranchType('new')}
                        className={cn(
                          'flex-1 px-3 py-1.5 text-xs font-medium rounded border transition-colors',
                          branchType === 'new'
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-secondary text-muted-foreground border-border hover:bg-muted'
                        )}
                      >
                        {t('newWorktree.newBranch')}
                      </button>
                      <button
                        onClick={() => setBranchType('existing')}
                        className={cn(
                          'flex-1 px-3 py-1.5 text-xs font-medium rounded border transition-colors',
                          branchType === 'existing'
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-secondary text-muted-foreground border-border hover:bg-muted'
                        )}
                      >
                        {t('newWorktree.existingBranch')}
                      </button>
                    </div>
                  </div>

                  {/* Branch picker for existing branches */}
                  {branchType === 'existing' && (
                    <div>
                      <label className="block text-xs font-medium text-muted-foreground mb-1">
                        {t('newWorktree.selectBranchLabel')}
                      </label>
                      {branchesLoading ? (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                          <Loader2 size={14} className="animate-spin" />
                          {t('newWorktree.loadingBranches')}
                        </div>
                      ) : (
                        <>
                          {/* Branch search */}
                          <div className="relative mb-2">
                            <Search
                              size={12}
                              className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                            />
                            <input
                              type="text"
                              value={branchSearch}
                              onChange={(e) => setBranchSearch(e.target.value)}
                              placeholder={t('newWorktree.searchBranches')}
                              className="w-full bg-secondary border border-border rounded pl-7 pr-3 py-1 text-xs text-foreground focus:ring-1 focus:ring-primary outline-none placeholder-muted-foreground"
                            />
                          </div>
                          {/* Remote toggle */}
                          <label className="flex items-center gap-1.5 mb-2 text-xs text-muted-foreground cursor-pointer">
                            <input
                              type="checkbox"
                              checked={showRemoteBranches}
                              onChange={(e) => setShowRemoteBranches(e.target.checked)}
                              className="rounded border-border"
                            />
                            {t('newWorktree.showRemote')}
                          </label>
                          {/* Branch list */}
                          <div className="max-h-32 overflow-y-auto border border-border rounded bg-secondary/50">
                            {sortedBranches.length === 0 ? (
                              <div className="p-2 text-xs text-muted-foreground text-center">
                                {t('newWorktree.noBranches')}
                              </div>
                            ) : (
                              sortedBranches.map((branch) => (
                                <button
                                  key={branch.name}
                                  onClick={() => setSelectedBranch(branch.name)}
                                  className={cn(
                                    'w-full flex items-center px-3 py-1 text-xs transition-colors text-left',
                                    selectedBranch === branch.name
                                      ? 'bg-primary/15 text-foreground'
                                      : 'text-muted-foreground hover:bg-sidebar-accent/50'
                                  )}
                                >
                                  <GitBranch size={10} className="mr-1.5 flex-shrink-0" />
                                  <span className="truncate flex-1">{branch.name}</span>
                                  {branch.isCurrent && (
                                    <span className="text-3xs text-primary ml-1">
                                      {t('newWorktree.current')}
                                    </span>
                                  )}
                                  {branch.isRemote && (
                                    <span className="text-3xs text-muted-foreground ml-1">
                                      {t('newWorktree.remote')}
                                    </span>
                                  )}
                                </button>
                              ))
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {/* New branch name + start ref */}
                  {branchType === 'new' && (
                    <>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          {t('newWorktree.branchName')}{' '}
                          <span className="text-muted-foreground/60">
                            {t('newWorktree.optional')}
                          </span>
                        </label>
                        <input
                          type="text"
                          value={newBranchName}
                          onChange={(e) => setNewBranchName(e.target.value)}
                          placeholder={
                            worktreeName
                              ? sanitizeBranchName(worktreeName)
                              : t('newWorktree.branchNamePlaceholder')
                          }
                          className="w-full bg-secondary border border-border rounded px-3 py-1.5 text-sm text-foreground focus:ring-1 focus:ring-primary outline-none placeholder-muted-foreground"
                        />
                        <p className="text-3xs text-muted-foreground mt-0.5">
                          {newBranchName && sanitizeBranchName(newBranchName) !== newBranchName
                            ? t('newWorktree.willSanitize', {
                                name: sanitizeBranchName(newBranchName)
                              })
                            : t('newWorktree.defaultsToName')}
                        </p>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          {t('newWorktree.startReference')}{' '}
                          <span className="text-muted-foreground/60">
                            {t('newWorktree.optional')}
                          </span>
                        </label>
                        <input
                          type="text"
                          value={startRef}
                          onChange={(e) => setStartRef(e.target.value)}
                          placeholder={t('newWorktree.startRefPlaceholder')}
                          className="w-full bg-secondary border border-border rounded px-3 py-1.5 text-sm text-foreground focus:ring-1 focus:ring-primary outline-none placeholder-muted-foreground"
                        />
                        <p className="text-3xs text-muted-foreground mt-0.5">
                          {t('newWorktree.defaultsToHead')}
                        </p>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Path preview */}
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  {t('newWorktree.pathPreview')}
                </label>
                <code className="block text-3xs text-muted-foreground bg-secondary/50 border border-border rounded px-3 py-1.5 overflow-x-auto whitespace-nowrap">
                  {pathPreview}
                </code>
              </div>

              {/* Symlink Directories section */}
              {project.symlinkDirs && project.symlinkDirs.length > 0 && (
                <div>
                  <button
                    onClick={() => setShowSymlinkSection(!showSymlinkSection)}
                    className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Link2 size={12} />
                    <span>
                      {t('newWorktree.symlinkDirectories', { count: project.symlinkDirs.length })}
                    </span>
                    <span className="text-3xs">{showSymlinkSection ? '▼' : '▶'}</span>
                  </button>
                  {showSymlinkSection && (
                    <div className="mt-1.5 border border-border rounded bg-secondary/30 p-2 space-y-1">
                      {project.symlinkDirs.map((dir) => (
                        <label
                          key={dir}
                          className="flex items-center gap-2 text-xs text-foreground cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={enabledSymlinkDirs.has(dir)}
                            onChange={(e) => {
                              const next = new Set(enabledSymlinkDirs)
                              if (e.target.checked) {
                                next.add(dir)
                              } else {
                                next.delete(dir)
                              }
                              setEnabledSymlinkDirs(next)
                            }}
                            className="rounded border-border"
                          />
                          <span>{dir}</span>
                        </label>
                      ))}
                      <p className="text-3xs text-muted-foreground mt-1">
                        {t('newWorktree.symlinkHint')}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Validation error */}
              {validationError && (
                <div className="flex items-start gap-2 text-xs text-red-500 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
                  <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
                  {validationError}
                </div>
              )}

              {/* Pre-check warnings */}
              {!isGitRepo && (
                <div className="flex items-start gap-2 text-xs text-amber-500 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2">
                  <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
                  {t('newWorktree.notGitWarning')}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-4 py-3 bg-secondary/50 flex justify-end gap-2 border-t border-border">
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                {t('newWorktree.cancel')}
              </button>
              <button
                onClick={() => void handleCreate()}
                disabled={!canProceed || isCreating || !worktreeName.trim()}
                className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded hover:bg-primary/90 shadow-md shadow-primary/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                {isCreating && <Loader2 size={12} className="animate-spin" />}
                {!isCreating && <Terminal size={12} />}
                {isCreating ? t('newWorktree.creating') : t('newWorktree.createAndOpen')}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
