import type { DetectedShells } from '@shared/types/ipc.types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Info } from '@/components/icons'
import { toastAccountChoiceError } from '@/components/settings/provider/account-choice-error'
import { ProjectProviderSettings } from '@/components/settings/provider/ProjectProviderSettings'
import { SettingsLayout, SettingsSection } from '@/components/settings/SettingsLayout'
import { SettingsModal } from '@/components/settings/SettingsModal'
import { Button } from '@/components/ui/button'
import { useProjectClaudeAccountDraft } from '@/hooks/use-project-claude-account-draft'
import { dialogApi, filesystemApi, shellApi, worktreeApi } from '@/lib/api'
import { mergeEnvVars, parseEnvFile, resolveProjectEnvPath } from '@/lib/env-parser'
import { renewAgentCredentials } from '@/stores/acp-store'
import { applyProjectClaudeAccount, CLAUDE_AGENT_CONFIG_ID } from '@/stores/claude-account-switch'
import { useActiveProjectId, useProjectActions, useProjectStore } from '@/stores/project-store'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import type { EnvVariable, Project, ProjectColor } from '@/types/project'
import {
  PROJECT_SETTINGS_CATEGORIES,
  PROJECT_SETTINGS_SEARCH_INDEX
} from './project-settings/categories'
import { EnvVarsSection } from './project-settings/env-vars-section'
import { GeneralSection } from './project-settings/general-section'
import { ShellSection } from './project-settings/shell-section'
import { SymlinksSection } from './project-settings/symlinks-section'

/** Id of the project the open modal edits, read outside render (async guards). */
function currentSettingsProjectId(): string {
  return useSettingsModalStore.getState().projectId || useProjectStore.getState().activeProjectId
}

export function ProjectSettingsModal() {
  const isOpen = useSettingsModalStore((state) => state.view === 'project')
  const close = useSettingsModalStore((state) => state.close)
  const openAppSettings = useSettingsModalStore((state) => state.openApp)
  const projectPage = useSettingsModalStore((state) => state.projectPage)
  const setProjectPage = useSettingsModalStore((state) => state.setProjectPage)
  const [isCloseConfirmOpen, setIsCloseConfirmOpen] = useState(false)
  // The modal edits the project it was opened for (a sidebar menu can open a
  // project that is not active), else the active project.
  const activeProjectId = useActiveProjectId()
  const targetProjectId = useSettingsModalStore((state) => state.projectId)
  const settingsProjectId = targetProjectId || activeProjectId
  const settingsProject = useProjectStore((state) =>
    state.projects.find((p) => p.id === settingsProjectId)
  )
  const claudeAccountDraft = useProjectClaudeAccountDraft(settingsProject?.id, { enabled: isOpen })
  const { updateProject } = useProjectActions()

  const [projectName, setProjectName] = useState(settingsProject?.name || '')
  const [selectedColor, setSelectedColor] = useState<ProjectColor>(settingsProject?.color || 'blue')
  const [rootPath, setRootPath] = useState(settingsProject?.path || '')
  const rootPathRef = useRef(rootPath)
  rootPathRef.current = rootPath
  const [envVars, setEnvVars] = useState<EnvVariable[]>(settingsProject?.envVars || [])
  const [shell, setShell] = useState(settingsProject?.defaultShell || '')
  const [hasChanges, setHasChanges] = useState(false)
  const [symlinkDirs, setSymlinkDirs] = useState<string[]>(settingsProject?.symlinkDirs ?? [])
  const [symlinkLoading, setSymlinkLoading] = useState(false)
  const [availableShells, setAvailableShells] = useState<DetectedShells | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [importWarnings, setImportWarnings] = useState<string | null>(null)
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
      }
    }
    fetchShells()
  }, [])

  // Tracks which project's form fields have been initialized, so a re-render
  // with a new settingsProject object (a store update for the same project)
  // cannot wipe fields the user, or the D5 auto-fill, has since changed.
  const symlinkInitProjectRef = useRef<string | null>(null)
  const autoFilledSymlinkRef = useRef<string | null>(null)
  const envImportRequestRef = useRef(0)

  // Puts every field back to the saved project and drops any pending .env read.
  const resetForm = useCallback((project: Project) => {
    setProjectName(project.name)
    setSelectedColor(project.color)
    setRootPath(project.path || '')
    // '' follows the app default shell, as the terminal openers do.
    setShell(project.defaultShell || '')
    envImportRequestRef.current += 1
    setEnvVars(project.envVars || [])
    setSymlinkDirs(project.symlinkDirs ?? [])
    setImportError(null)
    setImportWarnings(null)
    setHasChanges(false)
  }, [])

  // Sync state when the edited project changes
  useEffect(() => {
    if (settingsProject && symlinkInitProjectRef.current !== settingsProject.id) {
      symlinkInitProjectRef.current = settingsProject.id
      resetForm(settingsProject)
    }
  }, [settingsProject, resetForm])

  // The project the modal was opened for can be deleted or archived while the
  // modal is open (the registry keeps archived projects in the list with a
  // flag). Drop the edits and close once, so Save never runs against a project
  // that is gone. The active-project fallback (no target, no active project)
  // is left as is.
  const claudeDraftRef = useRef(claudeAccountDraft)
  claudeDraftRef.current = claudeAccountDraft
  const removedHandledRef = useRef<string | null>(null)
  const targetGone =
    isOpen && Boolean(targetProjectId) && (!settingsProject || Boolean(settingsProject.isArchived))
  useEffect(() => {
    if (!targetGone || !targetProjectId) {
      removedHandledRef.current = null
      return
    }
    if (removedHandledRef.current === targetProjectId) return
    removedHandledRef.current = targetProjectId
    claudeDraftRef.current.reset()
    envImportRequestRef.current += 1
    // Forget the initialized project so the next open re-reads its fields.
    symlinkInitProjectRef.current = null
    setImportError(null)
    setImportWarnings(null)
    setHasChanges(false)
    setIsCloseConfirmOpen(false)
    close()
    toast.info('Project was removed, settings closed.')
  }, [targetGone, targetProjectId, close])

  const handleDiscard = () => {
    claudeAccountDraft.reset()
    if (settingsProject) resetForm(settingsProject)
    else setHasChanges(false)
  }

  // D5: default worktree symlinks ON. For a git project that has never configured
  // symlink dirs, pre-fill them from .gitignore so fresh worktrees inherit shared
  // deps (e.g. node_modules) and don't break with "module not found". Runs once per
  // project and never overwrites a list the user has already configured (non-empty).
  useEffect(() => {
    const proj = settingsProject
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
    // not re-fire when other settingsProject fields change (which would re-parse and
    // fight user edits).
  }, [settingsProject?.id, settingsProject?.path, settingsProject?.isGitRepo, settingsProject])

  const handleSave = () => {
    if (settingsProject) {
      const normalizedEnvVars = envVars
        .map((envVar) => ({
          ...envVar,
          key: envVar.key.trim()
        }))
        .filter((envVar) => envVar.key !== '')

      // Normalize symlinkDirs: trim whitespace and remove empty/whitespace-only entries
      const normalizedSymlinkDirs = symlinkDirs.map((d) => d.trim()).filter((d) => d.length > 0)

      updateProject(settingsProject.id, {
        name: projectName,
        color: selectedColor,
        path: rootPath,
        envVars: normalizedEnvVars,
        defaultShell: shell,
        symlinkDirs: normalizedSymlinkDirs
      })
      const projectId = settingsProject.id
      // Before the host write, as the launcher chip does: a chat started while
      // the save runs must not land on an agent of the old Account.
      if (claudeAccountDraft.dirty) renewAgentCredentials(CLAUDE_AGENT_CONFIG_ID, projectId)
      void claudeAccountDraft
        .save()
        .then((changed) => {
          if (changed) void applyProjectClaudeAccount(projectId, { credentialsRenewed: true })
        })
        .catch((err) => {
          toastAccountChoiceError(err, 'Could not save the Claude account')
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

  const updateEnvVar = (index: number, patch: Partial<EnvVariable>) => {
    setEnvVars(envVars.map((envVar, i) => (i === index ? { ...envVar, ...patch } : envVar)))
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
    setSymlinkDirs(symlinkDirs.map((dir, i) => (i === index ? value : dir)))
    setHasChanges(true)
  }

  const browseRootPath = async () => {
    const result = await dialogApi.selectDirectory()
    if (result.success) {
      setRootPath(result.data)
      setHasChanges(true)
    }
  }

  const syncFromGitignore = async () => {
    if (!settingsProject?.path) return
    setSymlinkLoading(true)
    try {
      const result = await worktreeApi.parseGitignore(settingsProject.path)
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
    // Capture enough form identity to reject stale and out-of-order reads.
    const projectIdAtStart = settingsProjectId
    const normalizedRoot = rootPath.trim()
    const requestId = envImportRequestRef.current + 1
    envImportRequestRef.current = requestId

    setImportError(null)
    setImportWarnings(null)

    if (normalizedRoot === '') {
      setImportError('Project root is required to import .env.')
      return
    }

    const envPath = resolveProjectEnvPath(normalizedRoot)

    try {
      const readResult = await filesystemApi.readFile(envPath)

      // Read the store directly because this async callback retains values from
      // the render in which it started. The request/root checks also reject
      // overlapping reads and edits made while the adapter call is pending.
      if (
        requestId !== envImportRequestRef.current ||
        projectIdAtStart !== currentSettingsProjectId() ||
        normalizedRoot !== rootPathRef.current.trim()
      ) {
        return
      }

      if (!readResult.success) {
        setImportError(`Failed to read .env: ${readResult.error}`)
        return
      }

      const parseResult = parseEnvFile(readResult.data.content)

      if (parseResult.vars.length === 0 && parseResult.invalidLines.length === 0) {
        setImportError('The .env file is empty.')
        return
      }

      // Merge only when at least one variable parsed successfully. An invalid-only
      // file should report its skipped lines without claiming unsaved changes.
      if (parseResult.vars.length > 0) {
        setEnvVars((prevEnvVars) => mergeEnvVars(prevEnvVars, parseResult.vars))
        setHasChanges(true)
      }

      // Show warnings for invalid lines if any.
      if (parseResult.invalidLines.length > 0) {
        const warningDetails = parseResult.invalidLines
          .slice(0, 3)
          .map((l) => `Line ${l.line}: ${l.content}`)
          .join('\n')
        const moreCount =
          parseResult.invalidLines.length > 3
            ? ` (+${parseResult.invalidLines.length - 3} more)`
            : ''
        setImportWarnings(
          `Imported ${parseResult.vars.length} variables.\nSkipped ${parseResult.invalidLines.length} invalid line(s):\n${warningDetails}${moreCount}`
        )
      }
    } catch (error) {
      if (
        requestId !== envImportRequestRef.current ||
        projectIdAtStart !== currentSettingsProjectId() ||
        normalizedRoot !== rootPathRef.current.trim()
      ) {
        return
      }

      const message = error instanceof Error ? error.message : String(error)
      setImportError(`Failed to read .env: ${message}`)
    }
  }

  const handleClose = () => {
    if (hasChanges) {
      setIsCloseConfirmOpen(true)
    } else {
      close()
    }
  }

  return (
    <>
      <SettingsModal
        isOpen={isOpen}
        onClose={handleClose}
        title="Project settings"
        footer={
          hasChanges ? (
            <div className="flex items-center justify-end gap-2 px-4 py-3">
              <p
                role="status"
                className="mr-auto flex items-center gap-2 text-xs text-muted-foreground"
              >
                <Info size={14} aria-hidden="true" className="text-warning" />
                Unsaved changes
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8"
                onClick={handleDiscard}
              >
                Discard
              </Button>
              <Button type="button" size="sm" className="h-8" onClick={handleSave}>
                Save changes
              </Button>
            </div>
          ) : undefined
        }
      >
        <SettingsLayout
          title="Project settings"
          subtitle={settingsProject?.name}
          categories={PROJECT_SETTINGS_CATEGORIES}
          searchIndex={PROJECT_SETTINGS_SEARCH_INDEX}
          onClose={handleClose}
          page={projectPage ?? PROJECT_SETTINGS_CATEGORIES[0]?.id}
          onPageChange={setProjectPage}
        >
          <GeneralSection
            name={projectName}
            rootPath={rootPath}
            color={selectedColor}
            onNameChange={(name) => {
              setProjectName(name)
              setHasChanges(true)
            }}
            onRootPathChange={(path) => {
              setRootPath(path)
              setHasChanges(true)
            }}
            onBrowseRootPath={() => void browseRootPath()}
            onColorChange={(color) => {
              setSelectedColor(color)
              setHasChanges(true)
            }}
          />
          <ShellSection
            shell={shell}
            availableShells={availableShells}
            onShellChange={(next) => {
              setShell(next)
              setHasChanges(true)
            }}
          />
          <EnvVarsSection
            envVars={envVars}
            importError={importError}
            importWarnings={importWarnings}
            onImport={() => void handleImportEnvFile()}
            onAdd={addEnvVar}
            onChange={updateEnvVar}
            onRemove={removeEnvVar}
          />
          <SymlinksSection
            dirs={symlinkDirs}
            syncing={symlinkLoading}
            canSync={Boolean(settingsProject?.isGitRepo)}
            onSync={() => void syncFromGitignore()}
            onAdd={addSymlinkDir}
            onChange={updateSymlinkDir}
            onRemove={removeSymlinkDir}
          />
          <SettingsSection id="provider">
            <ProjectProviderSettings
              claude={claudeAccountDraft}
              onChange={() => setHasChanges(true)}
              onManageAccounts={() => {
                if (hasChanges) {
                  toast.warning('Save or discard your changes first.')
                  return
                }
                openAppSettings('provider')
              }}
            />
          </SettingsSection>
        </SettingsLayout>
      </SettingsModal>

      <ConfirmDialog
        isOpen={isCloseConfirmOpen}
        title="Unsaved Changes"
        message={`You have unsaved changes in ${settingsProject?.name ?? 'this project'}. Leaving will discard them.`}
        confirmLabel="Leave"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => {
          setIsCloseConfirmOpen(false)
          // The modal stays mounted while closed, so drop the edits here or they
          // reappear the next time it opens.
          handleDiscard()
          close()
        }}
        onCancel={() => setIsCloseConfirmOpen(false)}
      />
    </>
  )
}
